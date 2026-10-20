import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { SalesInvoice } from '../infrastructure/sales-invoice.entity';
import { SalesInvoiceLine } from '../infrastructure/sales-invoice-line.entity';
import { CustomerLedgerEntry } from '../infrastructure/customer-ledger-entry.entity';
import { SALES_INVOICE_PROCESS } from '../domain/sales-invoice-process';
import { CustomerLedgerService } from './customer-ledger.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { SALES_ORDERS_READ_CONTRACT, SalesOrdersReadContract, SALES_CUSTOMERS_CONTRACT, SalesCustomersContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { FinanceInvoiceContract, InvoiceReturnBasis } from '../../../foundation/module-registry/contracts/finance.contract';
import { AR_EVENT_TOPICS } from '../../../foundation/module-registry/contracts/ar-events.contract';
import { TAX_ENGINE_CONTRACT, TaxEngineContract } from '../../../foundation/module-registry/contracts/tax-engine.contract';

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
export class InvoiceService implements FinanceInvoiceContract {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly processEngine: ProcessEngineService,
    private readonly audit: AuditService,
    @Inject(SALES_ORDERS_READ_CONTRACT) private readonly salesOrders: SalesOrdersReadContract,
    @Inject(SALES_CUSTOMERS_CONTRACT) private readonly customers: SalesCustomersContract,
    private readonly ledger: CustomerLedgerService,
    private readonly events: EventBusService,
    @Inject(TAX_ENGINE_CONTRACT) private readonly taxEngine: TaxEngineContract,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  /**
   * F04 / handoff F04-H1 (ADR-036 D3), F10-H4 (ADR-043 D4/D5) —
   * `taxAccountCode` added. The AR event payload for a posted / voided
   * invoice. `customer-finance` is EGP-only today (`SalesInvoice` has no
   * currency column) — `currency: 'EGP'` is correct until the subledger
   * supports multi-currency (Blueprint §9 / Decision D-10).
   *
   * **F10 correctness fix (CTO-authorized scope, 2026-09-11 — see
   * `SalesInvoice.totalAmount`'s own doc comment):** `netAmount`/
   * `grossAmount` were previously `totalAmount - taxAmount` /
   * `totalAmount`, an assumption that `totalAmount` was already
   * tax-inclusive — harmless while `taxAmount` was always `'0.00'`, but
   * wrong the moment real tax exists (it would double-subtract tax from
   * an amount that never included it, understating the AR debit and
   * Revenue credit). `totalAmount` itself is NOT changed — it keeps its
   * pre-existing net/tax-exclusive meaning; only this derived-payload
   * arithmetic is corrected: `netAmount = totalAmount` (unchanged),
   * `grossAmount = totalAmount + taxAmount` (was `totalAmount` alone).
   */
  private arInvoiceEventPayload(invoice: SalesInvoice, taxAccountCode: string | null, kind: 'posted' | 'voided' = 'posted', extra: Record<string, unknown> = {}) {
    return {
      idempotencyKey: `customer-finance:invoice:${invoice.id}:${kind}`,
      businessDate: new Date().toISOString().slice(0, 10),
      orgUnitId: null,
      currency: 'EGP',
      sourceEntityType: 'invoice' as const,
      sourceEntityId: invoice.id,
      externalDocument: invoice.externalDocumentId
        ? {
            type: invoice.externalDocumentType ?? 'unknown',
            id: invoice.externalDocumentId,
            status: invoice.externalDocumentStatus,
            secondaryId: invoice.externalDocumentSecondaryId,
          }
        : null,
      payloadVersion: 1,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
      salesOrderId: invoice.salesOrderId,
      netAmount: invoice.totalAmount,
      taxAmount: invoice.taxAmount,
      taxAccountCode,
      grossAmount: this.grossAmountOf(invoice),
      dueDate: invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null,
      ...extra,
    };
  }

  /**
   * F10 correctness fix (CTO-authorized scope, 2026-09-11). `totalAmount`
   * keeps its net/tax-exclusive meaning (unchanged, per CTO ruling on
   * `SalesInvoice.totalAmount`'s own doc comment) — but "what the customer
   * actually owes for this invoice" (the Customer Ledger debit amount,
   * the AR-remaining calculation, the aging original amount) must be the
   * GROSS figure once real tax exists, or the Customer Ledger silently
   * drifts from the GL's own AR debit (`gross = net + tax`,
   * `handleInvoicePosted`) by exactly the tax amount on every posted
   * invoice — a real, growing reconciliation bug, not a cosmetic one.
   * Every call site that used to read `invoice.totalAmount` as "the full
   * amount owed" now reads this instead; `invoice.totalAmount` itself is
   * read/stored nowhere differently than before.
   */
  private grossAmountOf(invoice: SalesInvoice): string {
    return (Number(invoice.totalAmount) + Number(invoice.taxAmount)).toFixed(2);
  }

  /**
   * D4 (2026-10-05) — the original invoice value a return of this order reverses, read ONLY through the caller's manager
   * (Company context; no ambient DataSource, no tax engine). `createDraftInvoice` guarantees at most one non-void invoice per
   * order; only one that reached `posted`/`partially_paid`/`paid` created Revenue/AR.
   */
  async getReturnBasis(salesOrderId: string, manager?: EntityManager): Promise<InvoiceReturnBasis | null> {
    const runner = manager ?? this.dataSource;
    const invoices = await runner.getRepository(SalesInvoice).find({ where: { salesOrderId }, order: { createdAt: 'DESC' } });
    for (const invoice of invoices) {
      const state = await this.getStatus(invoice.id, manager);
      if (state !== 'posted' && state !== 'partially_paid' && state !== 'paid') continue;
      const lines = await runner.getRepository(SalesInvoiceLine).find({ where: { salesInvoiceId: invoice.id } });
      return {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customerId,
        salesOrderId: invoice.salesOrderId,
        state,
        totalNet: invoice.totalAmount,
        taxAmount: invoice.taxAmount,
        lines: lines.map((l) => ({ salesOrderLineId: l.salesOrderLineId, quantity: l.quantity, lineTotal: l.lineTotal })),
      };
    }
    return null;
  }

  /** CUS-01 — an on-account payment may be earmarked for a sales order only when that order belongs to the same customer (and the caller's Scope allows it). */
  async assertSalesOrderOfCustomer(salesOrderId: string, customerId: string, actorUserId: string, manager?: EntityManager): Promise<void> {
    const order = await this.salesOrders.getOrder(salesOrderId, actorUserId, manager);
    if (order.customerId !== customerId) throw new ForbiddenException('This sales order belongs to a different customer.');
  }

  async getStatus(invoiceId: string, manager?: EntityManager): Promise<string> {
    return this.processEngine.getState(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, manager);
  }

  /** Any invoice for this order that isn't `void` — the "does this order already have a live invoice" check `createDraftInvoice` uses to reject a duplicate. */
  async findOpenInvoiceForOrder(salesOrderId: string, manager?: EntityManager): Promise<SalesInvoice | null> {
    const invoices = await (manager ?? this.dataSource).getRepository(SalesInvoice).find({ where: { salesOrderId }, order: { createdAt: 'DESC' } });
    for (const invoice of invoices) {
      const state = await this.getStatus(invoice.id, manager);
      if (state !== 'void') return invoice;
    }
    return null;
  }

  async createDraftInvoice(salesOrderId: string, actorUserId: string, taxCodeId: string | null = null, manager?: EntityManager): Promise<SalesInvoice> {
    const order = await this.salesOrders.getOrder(salesOrderId, actorUserId, manager);
    const existing = await this.findOpenInvoiceForOrder(salesOrderId, manager);
    if (existing) {
      throw new ConflictException(`Sales order "${salesOrderId}" already has an invoice (${existing.invoiceNumber}).`);
    }

    const lines = await this.salesOrders.getOrderLines(salesOrderId, manager);
    if (lines.length === 0) {
      throw new BadRequestException(`Sales order "${salesOrderId}" has no lines to invoice.`);
    }

    const customer = await this.customers.getCustomer(order.customerId, actorUserId, manager);
    const dueDate = customer.paymentTermsDays != null ? new Date(Date.now() + customer.paymentTermsDays * 86400000) : null;

    const subtotal = lines.reduce((sum, l) => sum + Number(l.unitPrice) * l.quantity, 0);
    const discountAmount = lines.reduce((sum, l) => sum + Number(l.discountAmount), 0);
    const totalAmount = lines.reduce((sum, l) => sum + Number(l.lineTotal), 0);

    // F10-H3 (ADR-043 D3, Blueprint §0 amendment) — invoice-level tax, calculated ONCE here
    // and frozen onto the row. `postInvoice` NEVER recalculates (D3's CTO-mandated guarantee) —
    // it only reads the stored `taxAmount`/`taxCodeId` below.
    const taxResult = await this.taxEngine.calculateForInvoice(totalAmount.toFixed(2), taxCodeId, manager);

    await this.numbering.registerDocumentType(INVOICE_DOCUMENT_TYPE, INVOICE_PREFIX, undefined, manager); // idempotent
    const invoiceNumber = await this.numbering.getNextNumber(INVOICE_DOCUMENT_TYPE, manager);

    const invoice = await this.em(manager).transaction(async (manager) => {
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
          taxAmount: taxResult.taxAmount,
          taxCodeId: taxResult.taxCodeId,
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

    await this.processEngine.start(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoice.id, manager);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'invoice.created',
      resource: 'sales_invoice',
      resourceId: invoice.id,
      result: 'success',
      correlationId: null,
      after: { customerId: order.customerId, salesOrderId, totalAmount: invoice.totalAmount, dueDate },
    }, manager);

    return invoice;
  }

  /**
   * Posts the invoice's own debit — the ONE place an invoice ever hits the Customer Ledger. Sweeps
   * any unapplied deposit/COD entries for this same order onto it immediately after, then recomputes
   * status in case that sweep alone already covers it.
   *
   * Gap Resolution Package 3 (2026-09-14, row 35) — every write below now shares ONE transaction: the
   * `post` transition, the invoice header update, the AR debit entry, the outbox event, the unapplied-
   * entry sweep, the status recompute, and the audit record. Previously these were up to 7
   * independently-committing steps; a crash partway left a `posted`-in-name invoice with no AR debit,
   * or an AR debit with no invoice-header update.
   *
   * No separate `pg_advisory_xact_lock` is added here (unlike `recordPayment`'s per-invoice lock):
   * `ProcessEngineService.transition`'s own `SELECT ... FOR UPDATE` on `process_instances` already
   * serializes two concurrent `post` calls for the SAME invoice, and — now that it runs inside this
   * method's own transaction rather than its own separate one — that row lock is held for the entire
   * operation, not just the transition itself. A second concurrent call blocks on it until this one
   * commits, then correctly fails the `state !== 'draft'` guard once the process engine's own
   * from-state match check sees `posted`. Adding an advisory lock on top would be redundant
   * defense-in-depth with no additional guarantee — skipped per this codebase's own "no unnecessary
   * abstraction" convention, not merely by oversight.
   *
   * `manager` is optional (Mandatory Implementation Invariant, Blueprint P3 §7) — no current caller
   * supplies one (only `InvoicesController` calls this), kept consistent with the other four methods
   * in this package for the same reason.
   */
  async postInvoice(invoiceId: string, actorUserId: string, manager?: EntityManager): Promise<SalesInvoice> {
    const invoice = await this.em(manager).getRepository(SalesInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    await this.salesOrders.getOrder(invoice.salesOrderId, actorUserId, manager); // AUDIT-SEC-03 remediation: was a raw id lookup with no Scope check on a write path — any finance.invoice.post holder could post ANY invoice
    const state = await this.getStatus(invoiceId, manager);
    if (state !== 'draft') throw new ConflictException(`Cannot post an invoice in state "${state}".`);

    // F10-H4 (ADR-043 D5) — post-time-only account-code lookup, never a tax-amount
    // recalculation (D3): the invoice's `taxCodeId` was already frozen at draft time.
    const taxAccountCode = await this.taxEngine.resolveTaxAccountCode(invoice.taxCodeId, manager);

    const run = async (m: EntityManager): Promise<SalesInvoice> => {
      await this.processEngine.transition(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'post', actorUserId, m);
      invoice.postedByUserId = actorUserId;
      const savedInvoice = await m.getRepository(SalesInvoice).save(invoice);

      await this.ledger.postEntry(
        {
          customerId: invoice.customerId,
          entryType: 'sales_invoice',
          direction: 'debit',
          amount: this.grossAmountOf(invoice), // F10 correctness fix — see grossAmountOf's own doc comment
          salesOrderId: invoice.salesOrderId,
          invoiceId: invoice.id,
          reference: invoice.invoiceNumber,
          reason: 'Sales invoice posted',
          createdByUserId: actorUserId,
        },
        m,
      );
      await this.events.publish(m, AR_EVENT_TOPICS.invoicePosted, this.arInvoiceEventPayload(invoice, taxAccountCode));

      await this.ledger.sweepUnappliedFor(invoice.customerId, invoice.salesOrderId, invoice.id, m);
      await this.recomputeStatus(invoiceId, actorUserId, m);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'invoice.posted',
          resource: 'sales_invoice',
          resourceId: invoiceId,
          result: 'success',
          correlationId: null,
          after: { totalAmount: invoice.totalAmount },
        },
        m,
      );

      return savedInvoice;
    };

    // Area 21: a Company root `manager` (the controller's) is not a transaction — only a caller-supplied ACTIVE transaction is joined.
    const ownsTransaction = !manager?.queryRunner?.isTransactionActive;
    const saved = ownsTransaction ? await this.em(manager).transaction(run) : await run(manager!);
    if (ownsTransaction) await this.events.dispatchAfterCommit(manager); // same "only the transaction owner dispatches" convention as `recordPayment`/`TreasuryService.cashInCore`
    return saved;
  }

  /** Guards: nothing paid/credited yet. A `draft` invoice cancels cleanly (nothing was ever posted); a `posted` invoice with zero applied entries reverses its own debit first (never leaves an orphaned Customer Ledger row). */
  async voidInvoice(invoiceId: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<SalesInvoice> {
    const repo = this.em(manager).getRepository(SalesInvoice);
    const invoice = await repo.findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    await this.salesOrders.getOrder(invoice.salesOrderId, actorUserId, manager); // AUDIT-SEC-03 remediation: same write-path gap as postInvoice above
    const state = await this.getStatus(invoiceId, manager);
    if (state === 'void') throw new ConflictException(`Invoice "${invoiceId}" is already void.`);
    if (state === 'paid' || state === 'partially_paid') {
      throw new ConflictException(`Cannot void invoice "${invoiceId}" — it already has a payment or credit applied.`);
    }

    if (state === 'posted') {
      const entries = await this.em(manager)
        .getRepository(CustomerLedgerEntry)
        .find({ where: { invoiceId, entryType: 'sales_invoice', status: 'posted' } });
      for (const entry of entries) {
        await this.ledger.reverseEntry(entry.id, `Invoice voided: ${reason}`, actorUserId, manager);
      }
      await this.processEngine.transition(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'void', actorUserId, manager);
      // F10-H4 (ADR-043 D5) — same post-time-only lookup as postInvoice; reproduces the
      // IDENTICAL lines handleInvoicePosted originally drafted, so handleInvoiceVoided's
      // generic mirror flips exactly what was posted (D7).
      const taxAccountCode = await this.taxEngine.resolveTaxAccountCode(invoice.taxCodeId, manager);
      // F04-H1: the accounting event for a posted-state void (the GL reversal happens in accounting).
      await this.em(manager).transaction(async (manager) => {
        await this.events.publish(
          manager,
          AR_EVENT_TOPICS.invoiceVoided,
          this.arInvoiceEventPayload(invoice, taxAccountCode, 'voided', { voidReason: reason }),
        );
      });
      await this.events.dispatchAfterCommit(manager);
    } else {
      await this.processEngine.transition(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'cancel_draft', actorUserId, manager);
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
    }, manager);

    return saved;
  }

  /**
   * The full amount owed (`grossAmountOf` — net + tax, F10) minus every
   * non-`sales_invoice` ledger entry linked to this invoice (payments,
   * swept deposits/COD, return credit notes, debit notes) — never
   * re-derives from a stored balance field.
   * Deliberately NO `status` filter, same reasoning as
   * `CustomerLedgerService.getCustomerBalance` — a reversed entry's own
   * opposite-direction row already cancels it out; filtering by status
   * would double-exclude it and understate what's still owed.
   */
  async getInvoiceRemaining(invoiceId: string, manager?: EntityManager): Promise<string> {
    // Gap Resolution Package 3 (2026-09-14): `manager?` accepted so a caller already inside a
    // transaction (e.g. `PaymentsService.recordPayment`) reads this invoice's remaining balance
    // consistently WITH its own not-yet-committed writes, instead of a separate connection that
    // cannot see them yet. Callers outside a transaction are unaffected (falls back to `dataSource`).
    const runner = manager ?? this.dataSource;
    const invoice = await runner.getRepository(SalesInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const rows = await runner.query(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END), 0) AS applied
       FROM "customer_ledger_entries"
       WHERE "invoiceId" = $1 AND "entryType" != 'sales_invoice'`,
      [invoiceId],
    );
    const applied = Number(rows[0].applied);
    return (Number(this.grossAmountOf(invoice)) - applied).toFixed(2); // F10 correctness fix — see grossAmountOf's own doc comment
  }

  /** Fired after any ledger entry that could satisfy this invoice (payment, swept deposit/COD, applied return credit) — auto-advances `posted -> partially_paid -> paid` server-side, never a raw client action. */
  async recomputeStatus(invoiceId: string, actorUserId: string, manager?: EntityManager): Promise<string> {
    const state = await this.getStatus(invoiceId, manager);
    if (state !== 'posted' && state !== 'partially_paid') return state;

    const runner = manager ?? this.dataSource;
    const invoice = await runner.getRepository(SalesInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const remaining = Number(await this.getInvoiceRemaining(invoiceId, manager));

    if (remaining <= 0) {
      await this.processEngine.transition(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'mark_paid', actorUserId, manager);
    } else if (state === 'posted' && remaining < Number(this.grossAmountOf(invoice))) {
      await this.processEngine.transition(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'record_partial_payment', actorUserId, manager);
    }
    return this.getStatus(invoiceId, manager);
  }

  /**
   * T2 — the downward counterpart of `recomputeStatus`: after a payment reversal (a debit on the invoice), move `paid -> partially_paid | posted` or
   * `partially_paid -> posted` so the status always agrees with the derived remaining balance. Idempotent; a posted/void/draft invoice is untouched.
   */
  async resyncStatusAfterReversal(invoiceId: string, actorUserId: string, manager?: EntityManager): Promise<string> {
    const state = await this.getStatus(invoiceId, manager);
    if (state !== 'paid' && state !== 'partially_paid') return state;
    const runner = manager ?? this.dataSource;
    const invoice = await runner.getRepository(SalesInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    const remaining = Number(await this.getInvoiceRemaining(invoiceId, manager));
    const gross = Number(this.grossAmountOf(invoice));
    if (remaining >= gross) {
      await this.processEngine.transition(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'reopen', actorUserId, manager);
    } else if (state === 'paid' && remaining > 0) {
      await this.processEngine.transition(SALES_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'reopen_partial', actorUserId, manager);
    }
    return this.getStatus(invoiceId, manager);
  }

  async getInvoice(invoiceId: string, actorUserId: string, manager?: EntityManager): Promise<SalesInvoice & { state: string; remaining: string; lines: SalesInvoiceLine[] }> {
    const invoice = await this.em(manager).getRepository(SalesInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    await this.salesOrders.getOrder(invoice.salesOrderId, actorUserId, manager); // reuses the order's own Scope check
    const [lines, state, remaining] = await Promise.all([
      this.em(manager).getRepository(SalesInvoiceLine).find({ where: { salesInvoiceId: invoiceId } }),
      this.getStatus(invoiceId, manager),
      this.getInvoiceRemaining(invoiceId, manager),
    ]);
    return { ...invoice, state, remaining, lines };
  }

  async listInvoicesForCustomer(customerId: string, actorUserId: string, manager?: EntityManager): Promise<Array<SalesInvoice & { state: string; remaining: string }>> {
    await this.customers.getCustomer(customerId, actorUserId, manager); // Scope-checked, same as CustomerAccountsService
    const invoices = await this.em(manager).getRepository(SalesInvoice).find({ where: { customerId }, order: { createdAt: 'DESC' } });
    return Promise.all(
      invoices.map(async (invoice) => ({
        ...invoice,
        state: await this.getStatus(invoice.id, manager),
        remaining: await this.getInvoiceRemaining(invoice.id, manager),
      })),
    );
  }

  /** The shared per-invoice aging computation — used by both the single-customer and the all-customers variants below, so a bucket/remaining figure can never drift between the two (directive's own explicit "لا تعمل حسابات مستقلة قد تختلف عن Customer Account" instruction). Returns `null` when the invoice isn't a real AR line (draft/void/fully settled). */
  private async computeAgingRow(invoice: SalesInvoice, manager?: EntityManager): Promise<ArAgingRow | null> {
    const state = await this.getStatus(invoice.id, manager);
    if (state === 'void' || state === 'draft') return null;
    const remaining = Number(await this.getInvoiceRemaining(invoice.id, manager));
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
      originalAmount: this.grossAmountOf(invoice), // F10 correctness fix — see grossAmountOf's own doc comment
      paidAmount: (Number(this.grossAmountOf(invoice)) - remaining).toFixed(2),
      remaining: remaining.toFixed(2),
      daysOverdue,
      bucket,
    };
  }

  /** AR Aging (CTO directive §9) — Current/1-30/31-60/61-90/90+, only invoices with real remaining balance. */
  async getArAging(customerId: string, actorUserId: string, manager?: EntityManager): Promise<ArAgingRow[]> {
    await this.customers.getCustomer(customerId, actorUserId, manager);
    const invoices = await this.em(manager).getRepository(SalesInvoice).find({ where: { customerId }, order: { createdAt: 'ASC' } });
    const rows: ArAgingRow[] = [];
    for (const invoice of invoices) {
      const row = await this.computeAgingRow(invoice, manager);
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
  async listAllInvoices(actorUserId: string, manager?: EntityManager): Promise<Array<SalesInvoice & { state: string; remaining: string; customerCode: string; customerName: string }>> {
    const customers = await this.customers.listCustomers(actorUserId, manager);
    const customerById = new Map(customers.map((c) => [c.id, c]));
    if (customerById.size === 0) return [];

    const invoices = await this.em(manager)
      .getRepository(SalesInvoice)
      .find({ where: { customerId: In([...customerById.keys()]) }, order: { createdAt: 'DESC' } });

    return Promise.all(
      invoices.map(async (invoice) => ({
        ...invoice,
        state: await this.getStatus(invoice.id, manager),
        remaining: await this.getInvoiceRemaining(invoice.id, manager),
        customerCode: customerById.get(invoice.customerId)?.code ?? '',
        customerName: customerById.get(invoice.customerId)?.name ?? '',
      })),
    );
  }

  /** ERP UI Integration — "أعمار الديون" (all customers) list screen backing read. Same Scope-filtering and the SAME `computeAgingRow` formula as the single-customer `getArAging` — never a second independent calculation. */
  async getArAgingForAllCustomers(actorUserId: string, manager?: EntityManager): Promise<Array<ArAgingRow & { customerId: string; customerCode: string; customerName: string }>> {
    const customers = await this.customers.listCustomers(actorUserId, manager);
    const customerById = new Map(customers.map((c) => [c.id, c]));
    if (customerById.size === 0) return [];

    const invoices = await this.em(manager)
      .getRepository(SalesInvoice)
      .find({ where: { customerId: In([...customerById.keys()]) }, order: { createdAt: 'ASC' } });

    const rows: Array<ArAgingRow & { customerId: string; customerCode: string; customerName: string }> = [];
    for (const invoice of invoices) {
      const row = await this.computeAgingRow(invoice, manager);
      if (row) {
        const customer = customerById.get(invoice.customerId);
        rows.push({ ...row, customerId: invoice.customerId, customerCode: customer?.code ?? '', customerName: customer?.name ?? '' });
      }
    }
    return rows;
  }

  /** ERP UI Integration — the Sales Order → Invoice cross-link (§8): "does this order have a live invoice, and what's its current state." Same Scope check `getOrderLineById`'s callers already rely on. */
  async getInvoiceForSalesOrder(salesOrderId: string, actorUserId: string, manager?: EntityManager): Promise<(SalesInvoice & { state: string; remaining: string }) | null> {
    await this.salesOrders.getOrder(salesOrderId, actorUserId, manager); // Scope-checked
    const invoice = await this.findOpenInvoiceForOrder(salesOrderId, manager);
    if (!invoice) return null;
    return { ...invoice, state: await this.getStatus(invoice.id, manager), remaining: await this.getInvoiceRemaining(invoice.id, manager) };
  }
}
