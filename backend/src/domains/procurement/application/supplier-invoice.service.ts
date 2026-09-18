import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { SupplierInvoice } from '../infrastructure/supplier-invoice.entity';
import { SupplierInvoiceLine } from '../infrastructure/supplier-invoice-line.entity';
import { SupplierLedgerEntry } from '../infrastructure/supplier-ledger-entry.entity';
import { Supplier } from '../infrastructure/supplier.entity';
import { PurchaseOrder } from '../infrastructure/purchase-order.entity';
import { PurchaseOrderLine } from '../infrastructure/purchase-order-line.entity';
import { PURCHASE_ORDER_PROCESS } from '../domain/purchase-order-process';
import { SUPPLIER_INVOICE_PROCESS } from '../domain/supplier-invoice-process';
import { SupplierLedgerService } from './supplier-ledger.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { AP_EVENT_TOPICS } from '../../../foundation/module-registry/contracts/ap-events.contract';

const ENTITY_TYPE = 'supplier_invoice';
const PO_ENTITY_TYPE = 'purchase_order';
const INVOICE_DOCUMENT_TYPE = 'supplier_invoice';
const INVOICE_PREFIX = 'SINV';

export interface CreateSupplierInvoiceLineInput {
  purchaseOrderLineId: string;
  quantity: string;
  /** The supplier's own billed unit cost — cross-checked against the PO line's unitCostBase for the price-variance signal; NOT required to match exactly (variance is informational, never blocking). */
  unitCostBase: string;
}
export interface CreateSupplierInvoiceInput {
  purchaseOrderId: string;
  supplierReference?: string | null;
  lines: CreateSupplierInvoiceLineInput[];
}

export interface ApAgingRow {
  invoiceId: string;
  invoiceNumber: string;
  dueDate: Date | null;
  originalAmount: string;
  paidAmount: string;
  remaining: string;
  daysOverdue: number;
  bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
}

/**
 * ADR-048 — Supplier Invoice's own service, the exact mirror of
 * `InvoiceService` (customer-finance) for the payable side. 3-way match
 * (CTO directive §13): `createDraftInvoice` rejects outright when a line
 * would invoice more than has actually been received on the matching PO
 * line (`quantityReceived - quantityInvoiced`, the same over-X guard
 * shape `GoodsReceiptService` already uses for PO-vs-GR) — "missing
 * receipt" / "excess invoicing" are the SAME check, quantity variance is
 * hard-blocked. Price variance is computed and stored
 * (`priceVarianceAmount`/`unitCostVariance`) but never blocks posting —
 * informational, surfaced to the approver, matching how real supplier
 * pricing routinely differs by small amounts without being fraud.
 */
@Injectable()
export class SupplierInvoiceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly processEngine: ProcessEngineService,
    private readonly audit: AuditService,
    private readonly ledger: SupplierLedgerService,
    private readonly events: EventBusService,
  ) {}

  async getStatus(invoiceId: string, manager?: EntityManager): Promise<string> {
    return this.processEngine.getState(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, manager);
  }

  async createDraftInvoice(input: CreateSupplierInvoiceInput, actorUserId: string): Promise<SupplierInvoice> {
    if (input.lines.length === 0) throw new BadRequestException('A Supplier Invoice needs at least one line.');

    const po = await this.dataSource.getRepository(PurchaseOrder).findOne({ where: { id: input.purchaseOrderId } });
    if (!po) throw new NotFoundException(`Purchase Order "${input.purchaseOrderId}" not found.`);
    const poState = await this.processEngine.getState(PURCHASE_ORDER_PROCESS, PO_ENTITY_TYPE, po.id);
    if (poState !== 'partially_received' && poState !== 'received' && poState !== 'closed') {
      throw new ConflictException(`Purchase Order is "${poState}" — a Supplier Invoice can only be raised once at least one Goods Receipt has been posted against it.`);
    }

    const supplier = await this.dataSource.getRepository(Supplier).findOne({ where: { id: po.supplierId } });
    if (!supplier) throw new NotFoundException(`Supplier "${po.supplierId}" not found.`);
    const dueDate = supplier.paymentTermsDays != null ? new Date(Date.now() + supplier.paymentTermsDays * 86400000) : null;

    // 3-way match, duplicate-invoice leg: the same supplier's own reference number can't be billed
    // twice (a live, still-usable invoice — void doesn't count, matching how `findOpenInvoiceForOrder`
    // treats void on the AR side).
    if (input.supplierReference?.trim()) {
      const candidates = await this.dataSource
        .getRepository(SupplierInvoice)
        .find({ where: { supplierId: po.supplierId, supplierReference: input.supplierReference.trim() } });
      for (const candidate of candidates) {
        const candidateState = await this.getStatus(candidate.id);
        if (candidateState !== 'void') {
          throw new ConflictException(
            `Supplier reference "${input.supplierReference}" was already billed on invoice "${candidate.invoiceNumber}" (state "${candidateState}") — possible duplicate invoice.`,
          );
        }
      }
    }

    const poLines = await this.dataSource.getRepository(PurchaseOrderLine).find({ where: { purchaseOrderId: po.id } });
    const poLineById = new Map(poLines.map((l) => [l.id, l]));

    let totalAmount = 0;
    let priceVarianceAmount = 0;
    const lineEntities: Array<Omit<SupplierInvoiceLine, 'id' | 'supplierInvoiceId'>> = [];

    for (const line of input.lines) {
      const poLine = poLineById.get(line.purchaseOrderLineId);
      if (!poLine) throw new BadRequestException(`Purchase Order line "${line.purchaseOrderLineId}" does not belong to this order.`);

      const qty = Number(line.quantity);
      const cost = Number(line.unitCostBase);
      if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException('Every invoice line quantity must be a positive number.');
      if (!Number.isFinite(cost) || cost < 0) throw new BadRequestException('Every invoice line unit cost must be a non-negative number.');

      // 3-way match, quantity leg (hard guard): invoiced can never exceed received.
      const receivedNotYetInvoiced = Number(poLine.quantityReceived) - Number(poLine.quantityInvoiced);
      if (qty > receivedNotYetInvoiced) {
        throw new ConflictException(
          `Cannot invoice ${qty} on this line — only ${receivedNotYetInvoiced} has been received but not yet invoiced (received ${poLine.quantityReceived}, already invoiced ${poLine.quantityInvoiced}). Post a Goods Receipt first, or invoice a smaller quantity.`,
        );
      }

      // 3-way match, price leg (informational): variance vs the PO's own agreed unit cost.
      const unitCostVariance = cost - Number(poLine.unitCostBase);
      const lineTotal = qty * cost;
      priceVarianceAmount += Math.abs(unitCostVariance) * qty;
      totalAmount += lineTotal;

      lineEntities.push({
        purchaseOrderLineId: poLine.id,
        productId: poLine.productId,
        quantity: line.quantity,
        unitCostBase: line.unitCostBase,
        lineTotalBase: lineTotal.toFixed(2),
        unitCostVariance: unitCostVariance.toFixed(4),
      } as Omit<SupplierInvoiceLine, 'id' | 'supplierInvoiceId'>);
    }

    await this.numbering.registerDocumentType(INVOICE_DOCUMENT_TYPE, INVOICE_PREFIX);

    const invoice = await this.dataSource.transaction(async (manager) => {
      const invoiceNumber = await this.numbering.getNextNumber(INVOICE_DOCUMENT_TYPE, manager);
      const invoiceRepo = manager.getRepository(SupplierInvoice);
      const lineRepo = manager.getRepository(SupplierInvoiceLine);
      const poLineRepo = manager.getRepository(PurchaseOrderLine);

      const savedInvoice = await invoiceRepo.save(
        invoiceRepo.create({
          invoiceNumber,
          supplierReference: input.supplierReference ?? null,
          supplierId: po.supplierId,
          purchaseOrderId: po.id,
          totalAmount: totalAmount.toFixed(2),
          dueDate,
          priceVarianceAmount: priceVarianceAmount.toFixed(2),
          createdByUserId: actorUserId,
          postedByUserId: null,
          voidedReason: null,
        }),
      );
      await lineRepo.save(lineEntities.map((l) => lineRepo.create({ ...l, supplierInvoiceId: savedInvoice.id })));
      for (const line of input.lines) {
        await poLineRepo.increment({ id: line.purchaseOrderLineId }, 'quantityInvoiced', Number(line.quantity));
      }
      return savedInvoice;
    });

    await this.processEngine.start(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoice.id);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'supplier_invoice.created',
      resource: 'supplier_invoice',
      resourceId: invoice.id,
      result: 'success',
      correlationId: null,
      after: { supplierId: po.supplierId, purchaseOrderId: po.id, totalAmount: invoice.totalAmount, priceVarianceAmount: invoice.priceVarianceAmount },
    });

    return invoice;
  }

  /** Posts the invoice's own credit to the Supplier Ledger (AP up) — the ONE place a supplier invoice ever hits it — and publishes `finance.supplier_invoice.posted` for Accounting's GL handler. Mirrors `InvoiceService.postInvoice`'s single-transaction discipline. */
  async postInvoice(invoiceId: string, actorUserId: string): Promise<SupplierInvoice> {
    const invoice = await this.dataSource.getRepository(SupplierInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const state = await this.getStatus(invoiceId);
    if (state !== 'draft') throw new ConflictException(`Cannot post an invoice in state "${state}".`);

    const saved = await this.dataSource.transaction(async (m) => {
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'post', actorUserId, m);
      invoice.postedByUserId = actorUserId;
      const savedInvoice = await m.getRepository(SupplierInvoice).save(invoice);

      await this.ledger.postEntry(
        {
          supplierId: invoice.supplierId,
          entryType: 'supplier_invoice',
          direction: 'credit',
          amount: invoice.totalAmount,
          purchaseOrderId: invoice.purchaseOrderId,
          supplierInvoiceId: invoice.id,
          reference: invoice.invoiceNumber,
          reason: 'Supplier invoice posted',
          createdByUserId: actorUserId,
        },
        m,
      );

      await this.events.publish(m, AP_EVENT_TOPICS.supplierInvoicePosted, {
        idempotencyKey: `procurement:supplier_invoice:${invoice.id}:posted`,
        businessDate: new Date().toISOString().slice(0, 10),
        orgUnitId: null,
        currency: 'EGP',
        sourceEntityType: 'supplier_invoice' as const,
        sourceEntityId: invoice.id,
        externalDocument: null,
        payloadVersion: 1,
        supplierInvoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        supplierId: invoice.supplierId,
        purchaseOrderId: invoice.purchaseOrderId,
        netAmount: invoice.totalAmount,
        taxAmount: '0',
        grossAmount: invoice.totalAmount,
        dueDate: invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null,
      });

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'supplier_invoice.posted',
          resource: 'supplier_invoice',
          resourceId: invoiceId,
          result: 'success',
          correlationId: null,
          after: { totalAmount: invoice.totalAmount },
        },
        m,
      );

      return savedInvoice;
    });

    await this.events.dispatchPending();
    return saved;
  }

  async voidInvoice(invoiceId: string, reason: string, actorUserId: string): Promise<SupplierInvoice> {
    const repo = this.dataSource.getRepository(SupplierInvoice);
    const invoice = await repo.findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const state = await this.getStatus(invoiceId);
    if (state === 'void') throw new ConflictException(`Invoice "${invoiceId}" is already void.`);
    if (state === 'paid' || state === 'partially_paid') {
      throw new ConflictException(`Cannot void invoice "${invoiceId}" — it already has a payment applied.`);
    }

    if (state === 'posted') {
      const entries = await this.dataSource
        .getRepository(SupplierLedgerEntry)
        .find({ where: { supplierInvoiceId: invoiceId, entryType: 'supplier_invoice', status: 'posted' } });
      for (const entry of entries) {
        await this.ledger.reverseEntry(entry.id, `Invoice voided: ${reason}`, actorUserId);
      }
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'void', actorUserId);
      await this.dataSource.transaction(async (manager) => {
        await this.events.publish(manager, AP_EVENT_TOPICS.supplierInvoiceVoided, {
          idempotencyKey: `procurement:supplier_invoice:${invoice.id}:voided`,
          businessDate: new Date().toISOString().slice(0, 10),
          orgUnitId: null,
          currency: 'EGP',
          sourceEntityType: 'supplier_invoice' as const,
          sourceEntityId: invoice.id,
          externalDocument: null,
          payloadVersion: 1,
          supplierInvoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          supplierId: invoice.supplierId,
          purchaseOrderId: invoice.purchaseOrderId,
          netAmount: invoice.totalAmount,
          taxAmount: '0',
          grossAmount: invoice.totalAmount,
          dueDate: invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null,
          voidReason: reason,
        });
      });
      await this.events.dispatchPending();
    } else {
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'cancel_draft', actorUserId);
    }

    invoice.voidedReason = reason;
    const saved = await repo.save(invoice);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'supplier_invoice.voided',
      resource: 'supplier_invoice',
      resourceId: invoiceId,
      result: 'success',
      correlationId: null,
      after: { reason, fromState: state },
    });

    return saved;
  }

  /** The full amount owed minus every non-`supplier_invoice` ledger entry linked to this invoice (payments, credit notes) — never re-derives from a stored balance field. */
  async getInvoiceRemaining(invoiceId: string, manager?: EntityManager): Promise<string> {
    const runner = manager ?? this.dataSource;
    const invoice = await runner.getRepository(SupplierInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const rows = await runner.query(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END), 0) AS applied
       FROM "supplier_ledger_entries"
       WHERE "supplierInvoiceId" = $1 AND "entryType" != 'supplier_invoice'`,
      [invoiceId],
    );
    const applied = Number(rows[0].applied);
    return (Number(invoice.totalAmount) - applied).toFixed(2);
  }

  async recomputeStatus(invoiceId: string, actorUserId: string, manager?: EntityManager): Promise<string> {
    const state = await this.getStatus(invoiceId, manager);
    if (state !== 'posted' && state !== 'partially_paid') return state;

    const runner = manager ?? this.dataSource;
    const invoice = await runner.getRepository(SupplierInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const remaining = Number(await this.getInvoiceRemaining(invoiceId, manager));

    if (remaining <= 0) {
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'mark_paid', actorUserId, manager);
    } else if (state === 'posted' && remaining < Number(invoice.totalAmount)) {
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'record_partial_payment', actorUserId, manager);
    }
    return this.getStatus(invoiceId, manager);
  }

  async getInvoice(invoiceId: string): Promise<SupplierInvoice & { state: string; remaining: string; lines: SupplierInvoiceLine[] }> {
    const invoice = await this.dataSource.getRepository(SupplierInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const [lines, state, remaining] = await Promise.all([
      this.dataSource.getRepository(SupplierInvoiceLine).find({ where: { supplierInvoiceId: invoiceId } }),
      this.getStatus(invoiceId),
      this.getInvoiceRemaining(invoiceId),
    ]);
    return { ...invoice, state, remaining, lines };
  }

  async listForSupplier(supplierId: string): Promise<Array<SupplierInvoice & { state: string; remaining: string }>> {
    const invoices = await this.dataSource.getRepository(SupplierInvoice).find({ where: { supplierId }, order: { createdAt: 'DESC' } });
    return Promise.all(invoices.map(async (i) => ({ ...i, state: await this.getStatus(i.id), remaining: await this.getInvoiceRemaining(i.id) })));
  }

  async listForPurchaseOrder(purchaseOrderId: string): Promise<Array<SupplierInvoice & { state: string; remaining: string }>> {
    const invoices = await this.dataSource.getRepository(SupplierInvoice).find({ where: { purchaseOrderId }, order: { createdAt: 'DESC' } });
    return Promise.all(invoices.map(async (i) => ({ ...i, state: await this.getStatus(i.id), remaining: await this.getInvoiceRemaining(i.id) })));
  }

  async listAll(): Promise<Array<SupplierInvoice & { state: string; remaining: string }>> {
    const invoices = await this.dataSource.getRepository(SupplierInvoice).find({ order: { createdAt: 'DESC' } });
    return Promise.all(invoices.map(async (i) => ({ ...i, state: await this.getStatus(i.id), remaining: await this.getInvoiceRemaining(i.id) })));
  }

  private async computeAgingRow(invoice: SupplierInvoice): Promise<ApAgingRow | null> {
    const state = await this.getStatus(invoice.id);
    if (state === 'void' || state === 'draft') return null;
    const remaining = Number(await this.getInvoiceRemaining(invoice.id));
    if (remaining <= 0) return null;

    const daysOverdue = invoice.dueDate ? Math.max(0, Math.floor((Date.now() - invoice.dueDate.getTime()) / 86400000)) : 0;
    let bucket: ApAgingRow['bucket'];
    if (!invoice.dueDate || daysOverdue <= 0) bucket = 'current';
    else if (daysOverdue <= 30) bucket = '1-30';
    else if (daysOverdue <= 60) bucket = '31-60';
    else if (daysOverdue <= 90) bucket = '61-90';
    else bucket = '90+';

    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      dueDate: invoice.dueDate,
      originalAmount: invoice.totalAmount,
      paidAmount: (Number(invoice.totalAmount) - remaining).toFixed(2),
      remaining: remaining.toFixed(2),
      daysOverdue,
      bucket,
    };
  }

  /** AP Aging (CTO directive §3) — Current/1-30/31-60/61-90/90+, only invoices with real remaining balance. */
  async getApAging(supplierId: string): Promise<ApAgingRow[]> {
    const invoices = await this.dataSource.getRepository(SupplierInvoice).find({ where: { supplierId }, order: { createdAt: 'ASC' } });
    const rows: ApAgingRow[] = [];
    for (const invoice of invoices) {
      const row = await this.computeAgingRow(invoice);
      if (row) rows.push(row);
    }
    return rows;
  }

  /** AP Aging across every supplier — the "all suppliers" statement/aging screen backing read. */
  async getApAgingForAllSuppliers(): Promise<Array<ApAgingRow & { supplierId: string; supplierCode: string; supplierLegalName: string }>> {
    const suppliers = await this.dataSource.getRepository(Supplier).find();
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    const invoices = await this.dataSource.getRepository(SupplierInvoice).find({ order: { createdAt: 'ASC' } });
    const rows: Array<ApAgingRow & { supplierId: string; supplierCode: string; supplierLegalName: string }> = [];
    for (const invoice of invoices) {
      const row = await this.computeAgingRow(invoice);
      if (row) {
        const supplier = supplierById.get(invoice.supplierId);
        rows.push({ ...row, supplierId: invoice.supplierId, supplierCode: supplier?.code ?? '', supplierLegalName: supplier?.legalName ?? '' });
      }
    }
    return rows;
  }
}
