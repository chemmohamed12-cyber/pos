import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { SalesInvoice } from '../infrastructure/sales-invoice.entity';
import { SalesInvoiceLine } from '../infrastructure/sales-invoice-line.entity';
import { CustomerLedgerEntry } from '../infrastructure/customer-ledger-entry.entity';
import { SALES_INVOICE_PROCESS } from '../domain/sales-invoice-process';
import { CustomerLedgerService } from './customer-ledger.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { CustomersService } from '../../crm/application/customers.service';

const ENTITY_TYPE = 'sales_invoice';
const INVOICE_DOCUMENT_TYPE = 'sales_invoice';
const INVOICE_PREFIX = 'INV';

export interface ArAgingRow {
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
 * Customer Financial Account / Invoice / AR (CTO directive) — the Sales
 * Invoice's own service. Part of the Sales Order → Delivery → Invoice →
 * AR → Payment → Treasury chain: `createDraftInvoice` snapshots the
 * order's own lines (never live product prices, same discipline Returns
 * Phase A established), `postInvoice` is the one place a debit ever hits
 * the Customer Ledger, and once posted no direct mutation is allowed —
 * only `voidInvoice` (with its own guard against anything already
 * paid/credited) or a future Credit/Debit Note.
 */
@Injectable()
export class InvoiceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly processEngine: ProcessEngineService,
    private readonly audit: AuditService,
    private readonly salesOrders: SalesOrdersService,
    private readonly customers: CustomersService,
    private readonly ledger: CustomerLedgerService,
  ) {}

  async getStatus(invoiceId: string): Promise<string> {
    return this.processEngine.getState(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId);
  }

  /** Any invoice for this order that isn't `void` — the "does this order already have a live invoice" check `createDraftInvoice` uses to reject a duplicate. */
  async findOpenInvoiceForOrder(salesOrderId: string): Promise<SalesInvoice | null> {
    const invoices = await this.dataSource.getRepository(SalesInvoice).find({ where: { salesOrderId }, order: { createdAt: 'DESC' } });
    for (const invoice of invoices) {
      const state = await this.getStatus(invoice.id);
      if (state !== 'void') return invoice;
    }
    return null;
  }

  async createDraftInvoice(salesOrderId: string, actorUserId: string): Promise<SalesInvoice> {
    const order = await this.salesOrders.getOrder(salesOrderId, actorUserId);
    const existing = await this.findOpenInvoiceForOrder(salesOrderId);
    if (existing) {
      throw new ConflictException(`Sales order "${salesOrderId}" already has an invoice (${existing.invoiceNumber}).`);
    }

    const lines = await this.salesOrders.getOrderLines(salesOrderId);
    if (lines.length === 0) {
      throw new BadRequestException(`Sales order "${salesOrderId}" has no lines to invoice.`);
    }

    const customer = await this.customers.getCustomer(order.customerId, actorUserId);
    const dueDate = customer.paymentTermsDays != null ? new Date(Date.now() + customer.paymentTermsDays * 86400000) : null;

    const subtotal = lines.reduce((sum, l) => sum + Number(l.unitPrice) * l.quantity, 0);
    const discountAmount = lines.reduce((sum, l) => sum + Number(l.discountAmount), 0);
    const totalAmount = lines.reduce((sum, l) => sum + Number(l.lineTotal), 0);

    await this.numbering.registerDocumentType(INVOICE_DOCUMENT_TYPE, INVOICE_PREFIX); // idempotent
    const invoiceNumber = await this.numbering.getNextNumber(INVOICE_DOCUMENT_TYPE);

    const invoice = await this.dataSource.transaction(async (manager) => {
      const invoiceRepo = manager.getRepository(SalesInvoice);
      const lineRepo = manager.getRepository(SalesInvoiceLine);
      const savedInvoice = await invoiceRepo.save(
        invoiceRepo.create({
          invoiceNumber,
          customerId: order.customerId,
          salesOrderId,
          shipmentId: null,
          subtotal: subtotal.toFixed(2),
          discountAmount: discountAmount.toFixed(2),
          taxAmount: '0.00',
          totalAmount: totalAmount.toFixed(2),
          dueDate,
          createdByUserId: actorUserId,
          postedByUserId: null,
          voidedReason: null,
        }),
      );
      const lineEntities = lines.map((l) =>
        lineRepo.create({
          salesInvoiceId: savedInvoice.id,
          salesOrderLineId: l.id,
          productId: l.productId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountAmount: l.discountAmount,
          lineTotal: l.lineTotal,
        }),
      );
      await lineRepo.save(lineEntities);
      return savedInvoice;
    });

    await this.processEngine.start(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoice.id);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'invoice.created',
      resource: 'sales_invoice',
      resourceId: invoice.id,
      result: 'success',
      correlationId: null,
      after: { customerId: order.customerId, salesOrderId, totalAmount: invoice.totalAmount, dueDate },
    });

    return invoice;
  }

  /** Posts the invoice's own debit — the ONE place an invoice ever hits the Customer Ledger. Sweeps any unapplied deposit/COD entries for this same order onto it immediately after, then recomputes status in case that sweep alone already covers it. */
  async postInvoice(invoiceId: string, actorUserId: string): Promise<SalesInvoice> {
    const repo = this.dataSource.getRepository(SalesInvoice);
    const invoice = await repo.findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const state = await this.getStatus(invoiceId);
    if (state !== 'draft') throw new ConflictException(`Cannot post an invoice in state "${state}".`);

    await this.processEngine.transition(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'post', actorUserId);
    invoice.postedByUserId = actorUserId;
    const saved = await repo.save(invoice);

    await this.ledger.postEntry({
      customerId: invoice.customerId,
      entryType: 'sales_invoice',
      direction: 'debit',
      amount: invoice.totalAmount,
      salesOrderId: invoice.salesOrderId,
      invoiceId: invoice.id,
      reference: invoice.invoiceNumber,
      reason: 'Sales invoice posted',
      createdByUserId: actorUserId,
    });
    await this.ledger.sweepUnappliedFor(invoice.customerId, invoice.salesOrderId, invoice.id);
    await this.recomputeStatus(invoiceId, actorUserId);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'invoice.posted',
      resource: 'sales_invoice',
      resourceId: invoiceId,
      result: 'success',
      correlationId: null,
      after: { totalAmount: invoice.totalAmount },
    });

    return saved;
  }

  /** Guards: nothing paid/credited yet. A `draft` invoice cancels cleanly (nothing was ever posted); a `posted` invoice with zero applied entries reverses its own debit first (never leaves an orphaned Customer Ledger row). */
  async voidInvoice(invoiceId: string, reason: string, actorUserId: string): Promise<SalesInvoice> {
    const repo = this.dataSource.getRepository(SalesInvoice);
    const invoice = await repo.findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const state = await this.getStatus(invoiceId);
    if (state === 'void') throw new ConflictException(`Invoice "${invoiceId}" is already void.`);
    if (state === 'paid' || state === 'partially_paid') {
      throw new ConflictException(`Cannot void invoice "${invoiceId}" — it already has a payment or credit applied.`);
    }

    if (state === 'posted') {
      const entries = await this.dataSource
        .getRepository(CustomerLedgerEntry)
        .find({ where: { invoiceId, entryType: 'sales_invoice', status: 'posted' } });
      for (const entry of entries) {
        await this.ledger.reverseEntry(entry.id, `Invoice voided: ${reason}`, actorUserId);
      }
      await this.processEngine.transition(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'void', actorUserId);
    } else {
      await this.processEngine.transition(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'cancel_draft', actorUserId);
    }

    invoice.voidedReason = reason;
    const saved = await repo.save(invoice);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'invoice.voided',
      resource: 'sales_invoice',
      resourceId: invoiceId,
      result: 'success',
      correlationId: null,
      after: { reason, fromState: state },
    });

    return saved;
  }

  /**
   * totalAmount minus every non-`sales_invoice` ledger entry linked to
   * this invoice (payments, swept deposits/COD, return credit notes,
   * debit notes) — never re-derives from a stored balance field.
   * Deliberately NO `status` filter, same reasoning as
   * `CustomerLedgerService.getCustomerBalance` — a reversed entry's own
   * opposite-direction row already cancels it out; filtering by status
   * would double-exclude it and understate what's still owed.
   */
  async getInvoiceRemaining(invoiceId: string): Promise<string> {
    const invoice = await this.dataSource.getRepository(SalesInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const rows = await this.dataSource.query(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END), 0) AS applied
       FROM "customer_ledger_entries"
       WHERE "invoiceId" = $1 AND "entryType" != 'sales_invoice'`,
      [invoiceId],
    );
    const applied = Number(rows[0].applied);
    return (Number(invoice.totalAmount) - applied).toFixed(2);
  }

  /** Fired after any ledger entry that could satisfy this invoice (payment, swept deposit/COD, applied return credit) — auto-advances `posted -> partially_paid -> paid` server-side, never a raw client action. */
  async recomputeStatus(invoiceId: string, actorUserId: string): Promise<string> {
    const state = await this.getStatus(invoiceId);
    if (state !== 'posted' && state !== 'partially_paid') return state;

    const invoice = await this.dataSource.getRepository(SalesInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const remaining = Number(await this.getInvoiceRemaining(invoiceId));

    if (remaining <= 0) {
      await this.processEngine.transition(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'mark_paid', actorUserId);
    } else if (state === 'posted' && remaining < Number(invoice.totalAmount)) {
      await this.processEngine.transition(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'record_partial_payment', actorUserId);
    }
    return this.getStatus(invoiceId);
  }

  async getInvoice(invoiceId: string, actorUserId: string): Promise<SalesInvoice & { state: string; remaining: string; lines: SalesInvoiceLine[] }> {
    const invoice = await this.dataSource.getRepository(SalesInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    await this.salesOrders.getOrder(invoice.salesOrderId, actorUserId); // reuses the order's own Scope check
    const [lines, state, remaining] = await Promise.all([
      this.dataSource.getRepository(SalesInvoiceLine).find({ where: { salesInvoiceId: invoiceId } }),
      this.getStatus(invoiceId),
      this.getInvoiceRemaining(invoiceId),
    ]);
    return { ...invoice, state, remaining, lines };
  }

  async listInvoicesForCustomer(customerId: string, actorUserId: string): Promise<Array<SalesInvoice & { state: string; remaining: string }>> {
    await this.customers.getCustomer(customerId, actorUserId); // Scope-checked, same as CustomerAccountsService
    const invoices = await this.dataSource.getRepository(SalesInvoice).find({ where: { customerId }, order: { createdAt: 'DESC' } });
    return Promise.all(
      invoices.map(async (invoice) => ({
        ...invoice,
        state: await this.getStatus(invoice.id),
        remaining: await this.getInvoiceRemaining(invoice.id),
      })),
    );
  }

  /** The shared per-invoice aging computation — used by both the single-customer and the all-customers variants below, so a bucket/remaining figure can never drift between the two (directive's own explicit "لا تعمل حسابات مستقلة قد تختلف عن Customer Account" instruction). Returns `null` when the invoice isn't a real AR line (draft/void/fully settled). */
  private async computeAgingRow(invoice: SalesInvoice): Promise<ArAgingRow | null> {
    const state = await this.getStatus(invoice.id);
    if (state === 'void' || state === 'draft') return null;
    const remaining = Number(await this.getInvoiceRemaining(invoice.id));
    if (remaining <= 0) return null;

    const daysOverdue = invoice.dueDate ? Math.max(0, Math.floor((Date.now() - invoice.dueDate.getTime()) / 86400000)) : 0;
    let bucket: ArAgingRow['bucket'];
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

  /** AR Aging (CTO directive §9) — Current/1-30/31-60/61-90/90+, only invoices with real remaining balance. */
  async getArAging(customerId: string, actorUserId: string): Promise<ArAgingRow[]> {
    await this.customers.getCustomer(customerId, actorUserId);
    const invoices = await this.dataSource.getRepository(SalesInvoice).find({ where: { customerId }, order: { createdAt: 'ASC' } });
    const rows: ArAgingRow[] = [];
    for (const invoice of invoices) {
      const row = await this.computeAgingRow(invoice);
      if (row) rows.push(row);
    }
    return rows;
  }

  /**
   * ERP UI Integration (CTO directive) — "الفواتير" (all invoices) list
   * screen backing read. Scope-filtered via `CustomersService.listCustomers`
   * (a plain rep sees only their own customers' invoices, a reviewer role
   * sees all) — never a second, independently-derived visibility rule.
   */
  async listAllInvoices(actorUserId: string): Promise<Array<SalesInvoice & { state: string; remaining: string; customerCode: string; customerName: string }>> {
    const customers = await this.customers.listCustomers(actorUserId);
    const customerById = new Map(customers.map((c) => [c.id, c]));
    if (customerById.size === 0) return [];

    const invoices = await this.dataSource
      .getRepository(SalesInvoice)
      .find({ where: { customerId: In([...customerById.keys()]) }, order: { createdAt: 'DESC' } });

    return Promise.all(
      invoices.map(async (invoice) => ({
        ...invoice,
        state: await this.getStatus(invoice.id),
        remaining: await this.getInvoiceRemaining(invoice.id),
        customerCode: customerById.get(invoice.customerId)?.code ?? '',
        customerName: customerById.get(invoice.customerId)?.name ?? '',
      })),
    );
  }

  /** ERP UI Integration — "أعمار الديون" (all customers) list screen backing read. Same Scope-filtering and the SAME `computeAgingRow` formula as the single-customer `getArAging` — never a second independent calculation. */
  async getArAgingForAllCustomers(actorUserId: string): Promise<Array<ArAgingRow & { customerId: string; customerCode: string; customerName: string }>> {
    const customers = await this.customers.listCustomers(actorUserId);
    const customerById = new Map(customers.map((c) => [c.id, c]));
    if (customerById.size === 0) return [];

    const invoices = await this.dataSource
      .getRepository(SalesInvoice)
      .find({ where: { customerId: In([...customerById.keys()]) }, order: { createdAt: 'ASC' } });

    const rows: Array<ArAgingRow & { customerId: string; customerCode: string; customerName: string }> = [];
    for (const invoice of invoices) {
      const row = await this.computeAgingRow(invoice);
      if (row) {
        const customer = customerById.get(invoice.customerId);
        rows.push({ ...row, customerId: invoice.customerId, customerCode: customer?.code ?? '', customerName: customer?.name ?? '' });
      }
    }
    return rows;
  }

  /** ERP UI Integration — the Sales Order → Invoice cross-link (§8): "does this order have a live invoice, and what's its current state." Same Scope check `getOrderLineById`'s callers already rely on. */
  async getInvoiceForSalesOrder(salesOrderId: string, actorUserId: string): Promise<(SalesInvoice & { state: string; remaining: string }) | null> {
    await this.salesOrders.getOrder(salesOrderId, actorUserId); // Scope-checked
    const invoice = await this.findOpenInvoiceForOrder(salesOrderId);
    if (!invoice) return null;
    return { ...invoice, state: await this.getStatus(invoice.id), remaining: await this.getInvoiceRemaining(invoice.id) };
  }
}
