import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
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
import { InvoiceAllocationService } from './invoice-allocation.service';
import { InvoicePolicyService } from './invoice-policy.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';

const ENTITY_TYPE = 'supplier_invoice';
const PO_ENTITY_TYPE = 'purchase_order';
const INVOICE_DOCUMENT_TYPE = 'supplier_invoice';
const INVOICE_PREFIX = 'SINV';

export interface CreateSupplierInvoiceLineInput {
  purchaseOrderLineId: string;
  quantity: string;
  /** Optional: bill this goods-receipt line first (it must have free quantity); otherwise receipts are allocated first-in-first-out. */
  goodsReceiptLineId?: string | null;
  /** The supplier's own billed unit cost — cross-checked against the PO line's unitCostBase for the price-variance signal; NOT required to match exactly (variance is informational, never blocking). */
  unitCostBase: string;
}
export interface CreateSupplierInvoiceInput {
  /** The primary order (kept on the invoice header for compatibility). Omit when `purchaseOrderIds` is given. */
  purchaseOrderId?: string;
  /** Phase E (D4): one invoice covering several orders of the SAME supplier. Every order must be used by at least one line; every line must belong to one of them. */
  purchaseOrderIds?: string[];
  supplierReference?: string | null;
  lines: CreateSupplierInvoiceLineInput[];
  /** D5 — the EXPLICIT VAT amount stated by the supplier's invoice (the lines' total is NET). Omitted/0 = no VAT. Never derived or defaulted. */
  taxAmount?: string | null;
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
    // D5 — the accounting pre-flight (PPV / Input VAT accounts), bound by `accounting` through the foundation holder.
    @Optional() private readonly postingPolicy?: InventoryPostingPolicyRegistry,
    @Optional() allocations?: InvoiceAllocationService,
    @Optional() policies?: InvoicePolicyService,
  ) {
    this.allocations = allocations ?? new InvoiceAllocationService(dataSource);
    this.policies = policies ?? new InvoicePolicyService(dataSource);
  }

  private readonly allocations: InvoiceAllocationService;
  private readonly policies: InvoicePolicyService;

  async getStatus(invoiceId: string, manager?: EntityManager): Promise<string> {
    return this.processEngine.getState(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, manager);
  }

  private r4(n: number): number {
    return Math.round(n * 10000) / 10000;
  }

  /** D5 — gross = net (`totalAmount`, tax-exclusive) + the explicit VAT. What AP / the Supplier Ledger carry. */
  private grossOf(invoice: SupplierInvoice): number {
    return Math.round((Number(invoice.totalAmount) + Number(invoice.taxAmount ?? 0)) * 100) / 100;
  }

  private parseVatAmount(raw: string | number | null | undefined): number {
    if (raw == null || String(raw).trim() === '') return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new BadRequestException('The VAT amount must be a non-negative number.');
    return Math.round(n * 100) / 100;
  }

  /** D5 (CTO policy): VAT > 0 on an invoice from a supplier with no VAT registration number is rejected — the tax data is insufficient to prove a valid Input VAT. VAT = 0 is always allowed. */
  private assertVatAllowed(supplier: Supplier, tax: number): void {
    if (tax > 0 && !(supplier.vatRegistrationNumber ?? '').trim()) {
      throw new ConflictException(
        `Supplier "${supplier.legalName}" has no VAT registration number — Input VAT cannot be recorded on its invoice. Nothing was changed.`,
      );
    }
  }

  /** D5 — the figures a posted journal is built from, derived from the STORED invoice lines (receipt basis = qty × PO unit cost = qty × (billed cost − stored variance)). */
  private invoiceBasis(invoice: SupplierInvoice, lines: SupplierInvoiceLine[]): { net: number; receiptValue: number; ppv: number; tax: number; gross: number } {
    const net = Number(invoice.totalAmount);
    const receiptValue = this.r4(lines.reduce((sum, l) => sum + this.r4(Number(l.quantity) * (Number(l.unitCostBase) - Number(l.unitCostVariance))), 0));
    const ppv = this.r4(net - receiptValue);
    const tax = Number(invoice.taxAmount ?? 0);
    return { net, receiptValue, ppv, tax, gross: this.grossOf(invoice) };
  }

  /** D5 — give back the invoiced quantity of every line (void / cancel_draft), inside the caller's transaction; never below zero. */
  private async restoreInvoicedQuantities(lines: SupplierInvoiceLine[], m: EntityManager): Promise<void> {
    const poLineRepo = m.getRepository(PurchaseOrderLine);
    for (const line of lines) {
      const poLine = await poLineRepo.findOne({ where: { id: line.purchaseOrderLineId } });
      if (!poLine || Number(poLine.quantityInvoiced) < Number(line.quantity)) {
        throw new ConflictException(`Cannot restore the invoiced quantity of purchase order line "${line.purchaseOrderLineId}" — its invoiced quantity is lower than this invoice's line (data integrity). Nothing was changed.`);
      }
      await poLineRepo.decrement({ id: line.purchaseOrderLineId }, 'quantityInvoiced', Number(line.quantity));
    }
  }

  async createDraftInvoice(input: CreateSupplierInvoiceInput, actorUserId: string, manager?: EntityManager): Promise<SupplierInvoice> {
    if (input.lines.length === 0) throw new BadRequestException('A Supplier Invoice needs at least one line.');

    // Phase E (D4): the covered orders - the legacy single order, or several orders of one supplier. The first one is the "primary" order kept on the header.
    const orderIds = [...new Set([...(input.purchaseOrderId ? [input.purchaseOrderId] : []), ...(input.purchaseOrderIds ?? [])])];
    if (orderIds.length === 0) throw new BadRequestException('A Supplier Invoice needs a purchase order.');
    const orders: PurchaseOrder[] = [];
    for (const orderId of orderIds) {
      const found = await (manager ?? this.dataSource).getRepository(PurchaseOrder).findOne({ where: { id: orderId } });
      if (!found) throw new NotFoundException(`Purchase Order "${orderId}" not found.`);
      const foundState = await this.processEngine.getState(PURCHASE_ORDER_PROCESS, PO_ENTITY_TYPE, found.id, manager);
      if (foundState !== 'partially_received' && foundState !== 'received' && foundState !== 'closed') {
        throw new ConflictException(`Purchase Order ${found.poNumber} is "${foundState}" — a Supplier Invoice can only be raised once at least one Goods Receipt has been posted against it.`);
      }
      orders.push(found);
    }
    const po = orders[0];
    const foreign = orders.find((o) => o.supplierId !== po.supplierId);
    if (foreign) {
      throw new ConflictException(`Purchase orders ${po.poNumber} and ${foreign.poNumber} belong to different suppliers — one supplier invoice can only cover orders of the same supplier. / لا يجوز أن تغطي الفاتورة أوامر شراء لموردين مختلفين.`);
    }

    const supplier = await (manager ?? this.dataSource).getRepository(Supplier).findOne({ where: { id: po.supplierId } });
    if (!supplier) throw new NotFoundException(`Supplier "${po.supplierId}" not found.`);
    const dueDate = supplier.paymentTermsDays != null ? new Date(Date.now() + supplier.paymentTermsDays * 86400000) : null;

    // D5 — explicit VAT as stated by the supplier's invoice; validated BEFORE any write.
    const taxAmount = this.parseVatAmount(input.taxAmount);
    this.assertVatAllowed(supplier, taxAmount);

    // 3-way match, duplicate-invoice leg: the same supplier's own reference number can't be billed
    // twice (a live, still-usable invoice — void doesn't count, matching how `findOpenInvoiceForOrder`
    // treats void on the AR side).
    if (input.supplierReference?.trim()) {
      const candidates = await (manager ?? this.dataSource)
        .getRepository(SupplierInvoice)
        .find({ where: { supplierId: po.supplierId, supplierReference: input.supplierReference.trim() } });
      for (const candidate of candidates) {
        const candidateState = await this.getStatus(candidate.id, manager);
        if (candidateState !== 'void') {
          throw new ConflictException(
            `Supplier reference "${input.supplierReference}" was already billed on invoice "${candidate.invoiceNumber}" (state "${candidateState}") — possible duplicate invoice.`,
          );
        }
      }
    }

    const poLines = await (manager ?? this.dataSource).getRepository(PurchaseOrderLine).find({ where: { purchaseOrderId: In(orders.map((o) => o.id)) } });
    const poLineById = new Map(poLines.map((l) => [l.id, l]));
    const ordersUsed = new Set(input.lines.map((l) => poLineById.get(l.purchaseOrderLineId)?.purchaseOrderId).filter(Boolean));
    const unused = orders.find((o) => !ordersUsed.has(o.id));
    if (unused && input.lines.every((l) => poLineById.has(l.purchaseOrderLineId))) {
      throw new BadRequestException(`Purchase order ${unused.poNumber} is listed on the invoice but no line belongs to it.`);
    }

    let totalAmount = 0;
    let priceVarianceAmount = 0;
    let receiptValue = 0;
    const lineEntities: Array<Omit<SupplierInvoiceLine, 'id' | 'supplierInvoiceId'>> = [];

    for (const line of input.lines) {
      const poLine = poLineById.get(line.purchaseOrderLineId);
      if (!poLine) throw new BadRequestException(`Purchase Order line "${line.purchaseOrderLineId}" does not belong to the order(s) of this invoice.`);

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

      // 3-way match, price leg: variance vs the PO's own agreed unit cost. D5: it is now POSTED (to the configured PPV account), not just stored.
      const unitCostVariance = cost - Number(poLine.unitCostBase);
      const lineTotal = qty * cost;
      priceVarianceAmount += Math.abs(unitCostVariance) * qty;
      totalAmount += lineTotal;
      receiptValue += this.r4(qty * Number(poLine.unitCostBase));

      lineEntities.push({
        purchaseOrderLineId: poLine.id,
        productId: poLine.productId,
        quantity: line.quantity,
        unitCostBase: line.unitCostBase,
        lineTotalBase: lineTotal.toFixed(2),
        unitCostVariance: unitCostVariance.toFixed(4),
      } as Omit<SupplierInvoiceLine, 'id' | 'supplierInvoiceId'>);
    }

    const net = Number(totalAmount.toFixed(2));
    const receiptValueBase = this.r4(receiptValue);
    const ppvBase = this.r4(net - receiptValueBase);

    // T0-F1 (2026-10-04): was un-threaded (ambient/Platform connection) — a Company-scoped write must register the sequence in THIS Company's database.
    await this.numbering.registerDocumentType(INVOICE_DOCUMENT_TYPE, INVOICE_PREFIX, true, manager);

    const invoice = await (manager ?? this.dataSource).transaction(async (txManager) => {
      const invoiceNumber = await this.numbering.getNextNumber(INVOICE_DOCUMENT_TYPE, txManager);
      const invoiceRepo = txManager.getRepository(SupplierInvoice);
      const lineRepo = txManager.getRepository(SupplierInvoiceLine);
      const poLineRepo = txManager.getRepository(PurchaseOrderLine);

      const savedInvoice = await invoiceRepo.save(
        invoiceRepo.create({
          invoiceNumber,
          supplierReference: input.supplierReference ?? null,
          supplierId: po.supplierId,
          purchaseOrderId: po.id,
          totalAmount: net.toFixed(2),
          taxAmount: taxAmount.toFixed(2),
          receiptValueBase: receiptValueBase.toFixed(4),
          ppvBase: ppvBase.toFixed(4),
          dueDate,
          priceVarianceAmount: priceVarianceAmount.toFixed(2),
          createdByUserId: actorUserId,
          postedByUserId: null,
          voidedReason: null,
        }),
      );
      const savedLines = await lineRepo.save(lineEntities.map((l) => lineRepo.create({ ...l, supplierInvoiceId: savedInvoice.id })));
      // Phase A: bill specific goods receipts (race-safe per order line; the whole creation rolls back if the received-and-not-invoiced quantity is not there).
      await this.allocations.allocate(
        savedLines.map((sl, i) => ({
          supplierInvoiceLineId: sl.id,
          purchaseOrderLineId: sl.purchaseOrderLineId,
          quantity: Number(sl.quantity),
          goodsReceiptLineId: input.lines[i].goodsReceiptLineId ?? null,
        })),
        txManager,
      );
      for (const line of input.lines) {
        await poLineRepo.increment({ id: line.purchaseOrderLineId }, 'quantityInvoiced', Number(line.quantity));
      }
      return savedInvoice;
    });

    await this.processEngine.start(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoice.id, manager);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'supplier_invoice.created',
        resource: 'supplier_invoice',
        resourceId: invoice.id,
        result: 'success',
        correlationId: null,
        after: { supplierId: po.supplierId, purchaseOrderId: po.id, totalAmount: invoice.totalAmount, taxAmount: invoice.taxAmount, priceVarianceAmount: invoice.priceVarianceAmount, ppvBase: invoice.ppvBase },
      },
      manager,
    );

    return invoice;
  }

  /**
   * Posts the invoice — the ONE place a supplier invoice ever hits the Supplier Ledger — and publishes `finance.supplier_invoice.posted`.
   *
   * D5 flow: validate (state, VAT rule) → derive the figures from the stored lines → **resolve every required GL account
   * (pre-flight) BEFORE any write** → ONE transaction: state transition, Supplier Ledger credit = GROSS (net + VAT), event
   * carrying the receipt value / signed PPV / VAT → commit. A missing PPV account (variance ≠ 0), a missing/ambiguous Input VAT
   * account (VAT > 0) or an unregistered supplier with VAT rejects here, with nothing written.
   */
  async postInvoice(invoiceId: string, actorUserId: string, manager?: EntityManager): Promise<SupplierInvoice> {
    const invoice = await (manager ?? this.dataSource).getRepository(SupplierInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const state = await this.getStatus(invoiceId, manager);
    // Phase C-1 (D5): with the Company's approval workflow ON an invoice posts only from "approved"; OFF keeps the legacy direct draft -> posted path. (The transition below re-checks the state under the row lock.)
    const policy = await this.policies.get(manager);
    if (state !== 'approved' && !(state === 'draft' && !policy.approvalRequired)) {
      throw new ConflictException(
        state === 'draft' ? 'This Company requires supplier invoices to be submitted and approved before posting.' : `Cannot post an invoice in state "${state}".`,
      );
    }

    const lines = await (manager ?? this.dataSource).getRepository(SupplierInvoiceLine).find({ where: { supplierInvoiceId: invoiceId } });
    const basis = this.invoiceBasis(invoice, lines);
    const supplier = await (manager ?? this.dataSource).getRepository(Supplier).findOne({ where: { id: invoice.supplierId } });
    if (!supplier) throw new NotFoundException(`Supplier "${invoice.supplierId}" not found.`);
    this.assertVatAllowed(supplier, basis.tax);

    if (basis.ppv !== 0 || basis.tax > 0) {
      const policy = this.postingPolicy?.get();
      if (!policy) throw new ConflictException('This invoice has a price variance or VAT but the accounting posting policy is not available — nothing was changed.');
      await policy.assertSupplierInvoicePostable({ ppvBase: basis.ppv.toFixed(4), taxAmount: basis.tax.toFixed(2) }, manager ?? this.dataSource.manager);
    }

    const saved = await (manager ?? this.dataSource).transaction(async (m) => {
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, state === 'approved' ? 'post_approved' : 'post', actorUserId, m);
      invoice.postedByUserId = actorUserId;
      const savedInvoice = await m.getRepository(SupplierInvoice).save(invoice);

      await this.ledger.postEntry(
        {
          supplierId: invoice.supplierId,
          entryType: 'supplier_invoice',
          direction: 'credit',
          amount: basis.gross.toFixed(2), // D5: GROSS — what we owe the supplier (net + VAT)
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
        payloadVersion: 2,
        supplierInvoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        supplierId: invoice.supplierId,
        purchaseOrderId: invoice.purchaseOrderId,
        netAmount: invoice.totalAmount,
        taxAmount: basis.tax.toFixed(2),
        grossAmount: basis.gross.toFixed(2),
        receiptValueBase: basis.receiptValue.toFixed(4),
        ppvBase: basis.ppv.toFixed(4),
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
          after: { totalAmount: invoice.totalAmount, taxAmount: basis.tax.toFixed(2), ppvBase: basis.ppv.toFixed(4) },
        },
        m,
      );

      return savedInvoice;
    });

    await this.events.dispatchAfterCommit(manager);
    return saved;
  }

  /**
   * D5 — void / cancel is ONE atomic unit: Supplier Ledger reversal + state transition + (posted only) the void event whose GL
   * journal mirrors the posted one (GRNI, PPV, Input VAT, AP) + restoring every line's `quantityInvoiced`. Either all of it commits or none.
   */
  async voidInvoice(invoiceId: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<SupplierInvoice> {
    const repo = (manager ?? this.dataSource).getRepository(SupplierInvoice);
    const invoice = await repo.findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const state = await this.getStatus(invoiceId, manager);
    if (state === 'void') throw new ConflictException(`Invoice "${invoiceId}" is already void.`);
    if (state === 'paid' || state === 'partially_paid') {
      throw new ConflictException(`Cannot void invoice "${invoiceId}" — it already has a payment applied.`);
    }
    const lines = await (manager ?? this.dataSource).getRepository(SupplierInvoiceLine).find({ where: { supplierInvoiceId: invoiceId } });
    const gross = this.grossOf(invoice);

    const saved = await (manager ?? this.dataSource).transaction(async (m) => {
      if (state === 'posted') {
        const entries = await m.getRepository(SupplierLedgerEntry).find({ where: { supplierInvoiceId: invoiceId, entryType: 'supplier_invoice', status: 'posted' } });
        for (const entry of entries) {
          await this.ledger.reverseEntry(entry.id, `Invoice voided: ${reason}`, actorUserId, m);
        }
        await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'void', actorUserId, m);
        await this.events.publish(m, AP_EVENT_TOPICS.supplierInvoiceVoided, {
          idempotencyKey: `procurement:supplier_invoice:${invoice.id}:voided`,
          businessDate: new Date().toISOString().slice(0, 10),
          orgUnitId: null,
          currency: 'EGP',
          sourceEntityType: 'supplier_invoice' as const,
          sourceEntityId: invoice.id,
          externalDocument: null,
          payloadVersion: 2,
          supplierInvoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          supplierId: invoice.supplierId,
          purchaseOrderId: invoice.purchaseOrderId,
          netAmount: invoice.totalAmount,
          taxAmount: Number(invoice.taxAmount ?? 0).toFixed(2),
          grossAmount: gross.toFixed(2),
          dueDate: invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null,
          voidReason: reason,
        });
      } else {
        await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'cancel_draft', actorUserId, m);
      }
      await this.restoreInvoicedQuantities(lines, m);
      await this.allocations.release(lines.map((l) => l.id), m);

      invoice.voidedReason = reason;
      const savedInvoice = await m.getRepository(SupplierInvoice).save(invoice);
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'supplier_invoice.voided',
          resource: 'supplier_invoice',
          resourceId: invoiceId,
          result: 'success',
          correlationId: null,
          after: { reason, fromState: state, quantitiesRestored: lines.length },
        },
        m,
      );
      return savedInvoice;
    });

    if (state === 'posted') await this.events.dispatchAfterCommit(manager);
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
    return (this.grossOf(invoice) - applied).toFixed(2);
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
    } else if (state === 'posted' && remaining < this.grossOf(invoice)) {
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'record_partial_payment', actorUserId, manager);
    }
    return this.getStatus(invoiceId, manager);
  }

  async getInvoice(invoiceId: string, manager?: EntityManager): Promise<SupplierInvoice & { state: string; remaining: string; lines: SupplierInvoiceLine[] }> {
    const invoice = await (manager ?? this.dataSource).getRepository(SupplierInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const [lines, state, remaining] = await Promise.all([
      (manager ?? this.dataSource).getRepository(SupplierInvoiceLine).find({ where: { supplierInvoiceId: invoiceId } }),
      this.getStatus(invoiceId, manager),
      this.getInvoiceRemaining(invoiceId, manager),
    ]);
    return { ...invoice, state, remaining, lines };
  }

  async listForSupplier(supplierId: string, manager?: EntityManager): Promise<Array<SupplierInvoice & { state: string; remaining: string }>> {
    const invoices = await (manager ?? this.dataSource).getRepository(SupplierInvoice).find({ where: { supplierId }, order: { createdAt: 'DESC' } });
    return Promise.all(invoices.map(async (i) => ({ ...i, state: await this.getStatus(i.id, manager), remaining: await this.getInvoiceRemaining(i.id, manager) })));
  }

  async listForPurchaseOrder(purchaseOrderId: string, manager?: EntityManager): Promise<Array<SupplierInvoice & { state: string; remaining: string }>> {
    // Phase E: an invoice belongs to every order any of its lines belongs to (the header order is only the primary one)
    const covered: Array<{ id: string }> = await (manager ?? this.dataSource).query(
      `SELECT DISTINCT si."id" FROM "supplier_invoices" si LEFT JOIN "supplier_invoice_lines" sil ON sil."supplierInvoiceId" = si."id" LEFT JOIN "purchase_order_lines" pol ON pol."id" = sil."purchaseOrderLineId"
        WHERE si."purchaseOrderId" = $1 OR pol."purchaseOrderId" = $1`,
      [purchaseOrderId],
    );
    const invoices = await (manager ?? this.dataSource).getRepository(SupplierInvoice).find({ where: { id: In(covered.map((c) => c.id)) }, order: { createdAt: 'DESC' } });
    return Promise.all(invoices.map(async (i) => ({ ...i, state: await this.getStatus(i.id, manager), remaining: await this.getInvoiceRemaining(i.id, manager) })));
  }

  async listAll(manager?: EntityManager): Promise<Array<SupplierInvoice & { state: string; remaining: string }>> {
    const invoices = await (manager ?? this.dataSource).getRepository(SupplierInvoice).find({ order: { createdAt: 'DESC' } });
    return Promise.all(invoices.map(async (i) => ({ ...i, state: await this.getStatus(i.id, manager), remaining: await this.getInvoiceRemaining(i.id, manager) })));
  }

  private async computeAgingRow(invoice: SupplierInvoice, manager?: EntityManager): Promise<ApAgingRow | null> {
    const state = await this.getStatus(invoice.id, manager);
    if (state === 'void' || state === 'draft') return null;
    const remaining = Number(await this.getInvoiceRemaining(invoice.id, manager));
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
      originalAmount: this.grossOf(invoice).toFixed(2),
      paidAmount: (this.grossOf(invoice) - remaining).toFixed(2),
      remaining: remaining.toFixed(2),
      daysOverdue,
      bucket,
    };
  }

  /** AP Aging (CTO directive §3) — Current/1-30/31-60/61-90/90+, only invoices with real remaining balance. */
  async getApAging(supplierId: string, manager?: EntityManager): Promise<ApAgingRow[]> {
    const invoices = await (manager ?? this.dataSource).getRepository(SupplierInvoice).find({ where: { supplierId }, order: { createdAt: 'ASC' } });
    const rows: ApAgingRow[] = [];
    for (const invoice of invoices) {
      const row = await this.computeAgingRow(invoice, manager);
      if (row) rows.push(row);
    }
    return rows;
  }

  /** AP Aging across every supplier — the "all suppliers" statement/aging screen backing read. */
  async getApAgingForAllSuppliers(manager?: EntityManager): Promise<Array<ApAgingRow & { supplierId: string; supplierCode: string; supplierLegalName: string }>> {
    const suppliers = await (manager ?? this.dataSource).getRepository(Supplier).find();
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    const invoices = await (manager ?? this.dataSource).getRepository(SupplierInvoice).find({ order: { createdAt: 'ASC' } });
    const rows: Array<ApAgingRow & { supplierId: string; supplierCode: string; supplierLegalName: string }> = [];
    for (const invoice of invoices) {
      const row = await this.computeAgingRow(invoice, manager);
      if (row) {
        const supplier = supplierById.get(invoice.supplierId);
        rows.push({ ...row, supplierId: invoice.supplierId, supplierCode: supplier?.code ?? '', supplierLegalName: supplier?.legalName ?? '' });
      }
    }
    return rows;
  }
}
