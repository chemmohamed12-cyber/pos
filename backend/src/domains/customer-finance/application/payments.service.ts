import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { Payment } from '../infrastructure/payment.entity';
import { SalesInvoice } from '../infrastructure/sales-invoice.entity';
import { CustomerPaymentReversal } from '../infrastructure/customer-payment-reversal.entity';
import { CustomerLedgerService } from './customer-ledger.service';
import { InvoiceService } from './invoices.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { SALES_CUSTOMERS_CONTRACT, SalesCustomersContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { AR_EVENT_TOPICS } from '../../../foundation/module-registry/contracts/ar-events.contract';
import { runInTransaction } from '../../../foundation/transaction/run-in-transaction';

const PAYMENT_DOCUMENT_TYPE = 'customer_payment';
const PAYMENT_PREFIX = 'PAY';
const PAYMENT_REVERSAL_DOCUMENT_TYPE = 'customer_payment_reversal';
const PAYMENT_REVERSAL_PREFIX = 'PREV';

/**
 * Customer Financial Account / AR (CTO directive) — Customer → Payment →
 * Customer Account → Treasury. Never mutates a balance directly: posts
 * one Treasury `cash_in` (the SAME `TreasuryService` every other cash
 * inflow in this codebase already uses) then one Customer Ledger
 * `payment` credit entry, then lets `InvoiceService.recomputeStatus`
 * decide whether the invoice is now `partially_paid` or `paid`.
 * Overpayment is rejected outright (disclosed V1 simplification — a
 * "credit on account" concept for an overpayment is future work).
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly treasury: TreasuryService,
    private readonly ledger: CustomerLedgerService,
    private readonly invoices: InvoiceService,
    private readonly events: EventBusService,
    @Inject(SALES_CUSTOMERS_CONTRACT) private readonly customers: SalesCustomersContract,
  ) {}

  /**
   * Gap Resolution Package 3 (2026-09-14, Amendment-accepted `02_APPROVED_BLUEPRINT.md`) —
   * every write below now shares ONE transaction/`EntityManager`, closing rows 18/33/34: previously
   * the Treasury cash-in, the payment-number draw, the `Payment` row insert, the AR credit entry,
   * and the invoice-status recompute each committed independently, so a crash partway left a real
   * cash movement with no corresponding Payment/AR record. A `pg_advisory_xact_lock` keyed on the
   * invoice (same primitive `TreasuryService.cashInCore`/`postTransaction` already use, just keyed
   * differently) serializes two concurrent payments against the SAME invoice, closing the
   * "two individually-valid partial payments jointly overpay" race the required concurrent-execution
   * test in the Blueprint calls out — `getInvoiceRemaining` is read fresh, under the lock, from
   * inside this same transaction, not a value read before it.
   *
   * `manager` is optional (Mandatory Implementation Invariant, Blueprint P3 §7): when the caller
   * (e.g. `PaymentsController` via `IdempotencyService.withIdempotencyInTransaction`) already owns a
   * transaction, this method joins it and never opens its own — when called with no manager (every
   * existing test, and any other future caller), it opens exactly one transaction itself, byte-for-byte
   * the same shape the previous implementation's tests already assert.
   */
  async recordPayment(
    customerId: string,
    invoiceId: string,
    amount: string,
    method: string,
    treasuryAccountId: string,
    reference: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<Payment> {
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      throw new BadRequestException('Payment amount must be a positive number.');
    }
    await this.customers.getCustomer(customerId, actorUserId, manager); // AUDIT-SEC-03 remediation: was a raw write with no Scope check — any finance.payment.create holder could record a payment against any customer's invoice

    const run = async (m: EntityManager): Promise<Payment> => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payment:invoice:${invoiceId}`]);

      const invoice = await m.getRepository(SalesInvoice).findOne({ where: { id: invoiceId } });
      if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
      if (invoice.customerId !== customerId) {
        throw new ForbiddenException('This invoice belongs to a different customer.');
      }

      const remaining = Number(await this.invoices.getInvoiceRemaining(invoiceId, m));
      if (Number(amount) > remaining) {
        throw new ConflictException(`Cannot record ${amount} — only ${remaining.toFixed(2)} remains on invoice "${invoice.invoiceNumber}".`);
      }

      // D2: reject an unmapped receiving account BEFORE any treasury/ledger mutation; the mapped GL code travels in the event.
      const { glAccountCode } = await this.treasury.requireGlMappedAccount(treasuryAccountId, m);

      const treasuryTxn = await this.treasury.cashIn(treasuryAccountId, amount, customerId, invoice.salesOrderId, invoiceId, 'customer_payment', actorUserId, m);

      // Area 21 Operational Company Scoping Retrofit (2026-09-28): `m` now
      // threaded through — this row is always pre-seeded per Company by
      // `AddCustomerFinancialCore`'s own migration, so this call is a
      // guaranteed no-op in practice, but the pre-Area-21 ambient
      // `this.dataSource` call was still the wrong DataSource under
      // Model B (checked/would-insert against the Platform DB, not this
      // Company's), never something to leave uncorrected once noticed.
      await this.numbering.registerDocumentType(PAYMENT_DOCUMENT_TYPE, PAYMENT_PREFIX, true, m);
      const paymentNumber = await this.numbering.getNextNumber(PAYMENT_DOCUMENT_TYPE, m);

      const repo = m.getRepository(Payment);
      const saved = await repo.save(
        repo.create({
          paymentNumber,
          customerId,
          invoiceId,
          amount,
          method,
          treasuryAccountId,
          treasuryTransactionId: treasuryTxn.id,
          reference,
          recordedByUserId: actorUserId,
        }),
      );

      await this.ledger.postEntry(
        {
          customerId,
          entryType: 'payment',
          direction: 'credit',
          amount,
          salesOrderId: invoice.salesOrderId,
          invoiceId,
          paymentId: saved.id,
          treasuryTransactionId: treasuryTxn.id,
          reference: paymentNumber,
          reason: `Payment (${method})`,
          createdByUserId: actorUserId,
        },
        m,
      );
      await this.events.publish(m, AR_EVENT_TOPICS.paymentRecorded, {
        idempotencyKey: `customer-finance:payment:${saved.id}:recorded`,
        businessDate: new Date().toISOString().slice(0, 10),
        orgUnitId: null,
        currency: 'EGP',
        sourceEntityType: 'payment' as const,
        sourceEntityId: saved.id,
        externalDocument: null,
        payloadVersion: 1,
        paymentId: saved.id,
        paymentNumber,
        customerId,
        invoiceId,
        amount,
        method,
        treasuryAccountId,
        glAccountCode,
      });

      await this.invoices.recomputeStatus(invoiceId, actorUserId, m);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'customer_finance.payment.recorded',
          resource: 'customer_payment',
          resourceId: saved.id,
          result: 'success',
          correlationId: null,
          after: { customerId, invoiceId, amount, method, treasuryAccountId, treasuryTransactionId: treasuryTxn.id },
        },
        m,
      );

      return saved;
    };

    // C15 (T-31): the advisory lock, the remaining-balance check and every write below must share ONE transaction — join an ACTIVE caller transaction, otherwise open one on the
    // caller's manager (a plain manager releases the lock at once: 8 concurrent payments of 60.00 were all accepted against an invoice with 100.00 remaining). Same rule as applyPayment (F-PAY-001).
    const saved = await runInTransaction(this.dataSource, manager, run);
    // Same "who dispatches" convention as `TreasuryService.cashInCore`: only the call that owns the
    // transaction (no manager supplied) dispatches — a caller-supplied manager means the CALLER
    // decides when to dispatch, since only it knows when its own outer transaction actually commits.
    await this.events.dispatchAfterCommit(manager);
    return saved;
  }

  /**
   * CUS-01 (2026-10-06, CTO: Option 1) — an ON-ACCOUNT / ADVANCE customer payment: money received before an invoice exists. GL classification is the
   * EXISTING one (no new account): the same `finance.payment.recorded` event → Dr the Treasury account's mapped GL / Cr the `ar` control account,
   * exactly like a verified deposit; in the Customer Ledger it is an UNAPPLIED credit (`invoiceId = NULL`) shown as "Customer Advance / Unapplied
   * Receipt". Rejected BEFORE any mutation: amount ≤ 0, a customer / order outside the caller's scope or of another customer, an unmapped Treasury
   * account. Settlement: automatic (`sweepUnappliedFor`, when an earmarked order's invoice is posted) or explicit (`applyPayment`).
   */
  async recordOnAccountPayment(
    customerId: string,
    salesOrderId: string | null,
    amount: string,
    method: string,
    treasuryAccountId: string,
    reference: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<Payment> {
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new BadRequestException('Payment amount must be a positive number.');
    await this.customers.getCustomer(customerId, actorUserId, manager);
    if (salesOrderId) await this.invoices.assertSalesOrderOfCustomer(salesOrderId, customerId, actorUserId, manager);

    const run = async (m: EntityManager): Promise<Payment> => {
      const { glAccountCode } = await this.treasury.requireGlMappedAccount(treasuryAccountId, m); // D2 — before any treasury/ledger mutation
      const treasuryTxn = await this.treasury.cashIn(treasuryAccountId, amount, customerId, salesOrderId, null, 'customer_payment', actorUserId, m);

      await this.numbering.registerDocumentType(PAYMENT_DOCUMENT_TYPE, PAYMENT_PREFIX, true, m);
      const paymentNumber = await this.numbering.getNextNumber(PAYMENT_DOCUMENT_TYPE, m);
      const repo = m.getRepository(Payment);
      const saved = await repo.save(
        repo.create({ paymentNumber, customerId, invoiceId: null, salesOrderId, amount, method, treasuryAccountId, treasuryTransactionId: treasuryTxn.id, reference, recordedByUserId: actorUserId }),
      );
      await this.ledger.postEntry(
        {
          customerId,
          entryType: 'payment',
          direction: 'credit',
          amount,
          salesOrderId,
          invoiceId: null, // UNAPPLIED
          paymentId: saved.id,
          treasuryTransactionId: treasuryTxn.id,
          reference: paymentNumber,
          reason: `On-account payment (${method})`,
          createdByUserId: actorUserId,
        },
        m,
      );
      await this.events.publish(m, AR_EVENT_TOPICS.paymentRecorded, {
        idempotencyKey: `customer-finance:payment:${saved.id}:recorded`,
        businessDate: new Date().toISOString().slice(0, 10),
        orgUnitId: null,
        currency: 'EGP',
        sourceEntityType: 'payment' as const,
        sourceEntityId: saved.id,
        externalDocument: null,
        payloadVersion: 1,
        paymentId: saved.id,
        paymentNumber,
        customerId,
        invoiceId: null,
        amount,
        method,
        treasuryAccountId,
        glAccountCode,
      });
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'customer_finance.payment.recorded_on_account',
          resource: 'customer_payment',
          resourceId: saved.id,
          result: 'success',
          correlationId: null,
          after: { customerId, salesOrderId, amount, method, treasuryAccountId, treasuryTransactionId: treasuryTxn.id },
        },
        m,
      );
      return saved;
    };
    // C15 (T-31): the cash-in, the payment row, the ledger credit, the event and the audit row must be ONE unit of work — join an ACTIVE caller transaction, otherwise open one on the
    // caller's manager (a plain manager commits each statement separately, so a failure part-way leaves a real cash movement with no complete record). Same rule as recordPayment above.
    const saved = await runInTransaction(this.dataSource, manager, run);
    await this.events.dispatchAfterCommit(manager);
    return saved;
  }

  /**
   * T2 (2026-10-20) — REVERSE a customer payment through its OWNING document: ONE transaction that (1) appends the offsetting Treasury leg (no event of its own),
   * (2) mirrors the payment's Customer Ledger credit(s) with `payment_reversal` debits wherever they currently sit (unapplied, on an invoice, or split by an
   * application), (3) publishes the mirror GL event `finance.payment.reversed` (Dr AR / Cr the receiving account's mapped GL), (4) re-opens every invoice the
   * payment had settled, (5) records the one-per-payment reversal row (UNIQUE on paymentId) and audits. Rejected BEFORE any mutation: blank reason, payment of a
   * customer outside the caller's scope, already reversed, an unmapped Treasury account, a ledger that does not add up to the payment amount, a voided invoice,
   * a receiving account that cannot fund the refund. The original payment, ledger rows, Treasury leg and journal stay untouched and linked.
   */
  async reversePayment(
    paymentId: string,
    reason: string,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<{ reversalId: string; reversalNumber: string; paymentId: string; amount: string; invoicesReopened: string[] }> {
    const why = (reason ?? '').trim();
    if (why.length < 3) throw new BadRequestException('A reason is required to reverse a payment.');
    const run = async (m: EntityManager) => {
      const payment = await m.getRepository(Payment).findOne({ where: { id: paymentId } });
      if (!payment) throw new NotFoundException(`Payment "${paymentId}" not found.`);
      await this.customers.getCustomer(payment.customerId, actorUserId, m); // Scope
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payment:apply:${paymentId}`]);
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payment:reverse:${paymentId}`]);

      const already = await m.getRepository(CustomerPaymentReversal).findOne({ where: { paymentId } });
      if (already) throw new ConflictException(`Payment "${payment.paymentNumber}" was already reversed (${already.reversalNumber}).`);
      if (!payment.treasuryTransactionId) throw new ConflictException(`Payment "${payment.paymentNumber}" has no Treasury movement to reverse.`);

      // where the payment's credit(s) currently sit in the Customer Ledger (net credit per invoice / unapplied bucket)
      const buckets: Array<{ invoiceId: string | null; salesOrderId: string | null; net: string }> = await m.query(
        `SELECT "invoiceId", "salesOrderId", SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END)::text AS net
         FROM "customer_ledger_entries" WHERE "paymentId" = $1 GROUP BY "invoiceId", "salesOrderId" HAVING SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END) <> 0
         ORDER BY "invoiceId" NULLS FIRST`,
        [paymentId],
      );
      const total = buckets.reduce((a, b) => a + Number(b.net), 0);
      if (buckets.some((b) => Number(b.net) < 0) || Math.abs(total - Number(payment.amount)) > 0.004) {
        throw new ConflictException(`The Customer Ledger for payment "${payment.paymentNumber}" does not add up to its amount (${payment.amount}) — it cannot be reversed automatically. Nothing was changed.`);
      }
      const invoiceIds = [...new Set(buckets.map((b) => b.invoiceId).filter((id): id is string => !!id))].sort();
      for (const id of invoiceIds) {
        await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payment:invoice:${id}`]);
        const state = await this.invoices.getStatus(id, m);
        if (state === 'void') throw new ConflictException(`Invoice ${id} is void — the payment cannot be reversed against it. Nothing was changed.`);
      }

      const { glAccountCode } = await this.treasury.requireGlMappedAccount(payment.treasuryAccountId, m);
      const reversalLeg = await this.treasury.reverseOwnedLeg(payment.treasuryTransactionId, `payment ${payment.paymentNumber}: ${why}`, actorUserId, m);

      await this.numbering.registerDocumentType(PAYMENT_REVERSAL_DOCUMENT_TYPE, PAYMENT_REVERSAL_PREFIX, true, m);
      const reversalNumber = await this.numbering.getNextNumber(PAYMENT_REVERSAL_DOCUMENT_TYPE, m);
      const repo = m.getRepository(CustomerPaymentReversal);
      const reversal = await repo.save(
        repo.create({ reversalNumber, paymentId, reason: why, reversedByUserId: actorUserId, treasuryReversalTransactionId: reversalLeg.id, amount: payment.amount }),
      );

      for (const b of buckets) {
        await this.ledger.postEntry(
          {
            customerId: payment.customerId,
            entryType: 'payment_reversal',
            direction: 'debit',
            amount: Number(b.net).toFixed(2),
            salesOrderId: b.salesOrderId,
            invoiceId: b.invoiceId,
            paymentId,
            treasuryTransactionId: reversalLeg.id,
            reference: reversalNumber,
            reason: `Reversal of payment ${payment.paymentNumber}: ${why}`,
            createdByUserId: actorUserId,
          },
          m,
        );
      }

      await this.events.publish(m, AR_EVENT_TOPICS.paymentReversed, {
        idempotencyKey: `customer-finance:payment:${paymentId}:reversed`,
        businessDate: new Date().toISOString().slice(0, 10),
        orgUnitId: null,
        currency: 'EGP',
        sourceEntityType: 'payment' as const,
        sourceEntityId: paymentId,
        externalDocument: null,
        payloadVersion: 1,
        paymentId,
        paymentNumber: payment.paymentNumber,
        reversalNumber,
        customerId: payment.customerId,
        amount: payment.amount,
        treasuryAccountId: payment.treasuryAccountId,
        glAccountCode,
        reversalOf: paymentId,
        reason: why,
      });

      for (const id of invoiceIds) await this.invoices.resyncStatusAfterReversal(id, actorUserId, m);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'customer_finance.payment.reversed',
          resource: 'customer_payment',
          resourceId: paymentId,
          result: 'success',
          correlationId: reversal.id,
          after: { reversalNumber, amount: payment.amount, reason: why, treasuryReversalTransactionId: reversalLeg.id, invoices: invoiceIds },
        },
        m,
      );
      return { reversalId: reversal.id, reversalNumber, paymentId, amount: payment.amount, invoicesReopened: invoiceIds };
    };
    const result = await runInTransaction(this.dataSource, manager, run);
    await this.events.dispatchAfterCommit(manager);
    return result;
  }

  /** CUS-01 — what is still UNAPPLIED on a payment: Σ(credit − debit) of its ledger rows that carry no invoice (derived, never stored; no status filter — same discipline as every balance here). */
  async getUnappliedBalance(paymentId: string, manager?: EntityManager): Promise<string> {
    const rows = await (manager ?? this.dataSource).query(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END), 0) AS unapplied
       FROM "customer_ledger_entries" WHERE "paymentId" = $1 AND "invoiceId" IS NULL`,
      [paymentId],
    );
    return Number(rows[0].unapplied).toFixed(2);
  }

  /**
   * CUS-01 — EXPLICIT settlement of an unapplied receipt against an invoice (partial application supported; the Customer Ledger stays append-only:
   * two new `payment_application` rows — a debit that takes the amount out of "unapplied" and a credit that lands it on the invoice — the net customer
   * balance and the GL are unchanged, the credit already sits in AR). Rejected BEFORE any mutation: amount ≤ 0, payment/invoice of different
   * customers, invoice not open (posted / partially_paid), amount > the payment's unapplied balance, amount > the invoice's outstanding balance.
   */
  async applyPayment(paymentId: string, invoiceId: string, amount: string, actorUserId: string, manager?: EntityManager): Promise<{ paymentId: string; invoiceId: string; applied: string; unappliedRemaining: string; invoiceRemaining: string }> {
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new BadRequestException('Application amount must be a positive number.');
    const run = async (m: EntityManager) => {
      const payment = await m.getRepository(Payment).findOne({ where: { id: paymentId } });
      if (!payment) throw new NotFoundException(`Payment "${paymentId}" not found.`);
      await this.customers.getCustomer(payment.customerId, actorUserId, m); // Scope
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payment:apply:${paymentId}`]);
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payment:invoice:${invoiceId}`]);

      const invoice = await m.getRepository(SalesInvoice).findOne({ where: { id: invoiceId } });
      if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
      if (invoice.customerId !== payment.customerId) throw new ForbiddenException('This invoice belongs to a different customer than the payment.');
      const state = await this.invoices.getStatus(invoiceId, m);
      if (state !== 'posted' && state !== 'partially_paid') throw new ConflictException(`Invoice "${invoice.invoiceNumber}" is "${state}" — a payment can only be applied to a posted or partially paid invoice.`);

      const unapplied = Number(await this.getUnappliedBalance(paymentId, m));
      if (Number(amount) > unapplied) throw new ConflictException(`Cannot apply ${amount} — only ${unapplied.toFixed(2)} of payment "${payment.paymentNumber}" is unapplied.`);
      const remaining = Number(await this.invoices.getInvoiceRemaining(invoiceId, m));
      if (Number(amount) > remaining) throw new ConflictException(`Cannot apply ${amount} — only ${remaining.toFixed(2)} remains on invoice "${invoice.invoiceNumber}".`);

      const common = { customerId: payment.customerId, entryType: 'payment_application' as const, amount, paymentId, reference: payment.paymentNumber, createdByUserId: actorUserId };
      // out of "unapplied" (salesOrderId deliberately NULL: this row must never be picked up by the invoice-post sweep)
      await this.ledger.postEntry({ ...common, direction: 'debit', salesOrderId: null, invoiceId: null, reason: `Applied to invoice ${invoice.invoiceNumber}` }, m);
      // onto the invoice
      await this.ledger.postEntry({ ...common, direction: 'credit', salesOrderId: invoice.salesOrderId, invoiceId, reason: `Applied from payment ${payment.paymentNumber}` }, m);
      await this.invoices.recomputeStatus(invoiceId, actorUserId, m);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'customer_finance.payment.applied', resource: 'customer_payment', resourceId: paymentId, result: 'success', correlationId: invoiceId, after: { invoiceId, amount } },
        m,
      );
      return {
        paymentId,
        invoiceId,
        applied: Number(amount).toFixed(2),
        unappliedRemaining: (unapplied - Number(amount)).toFixed(2),
        invoiceRemaining: (remaining - Number(amount)).toFixed(2),
      };
    };
    // F-PAY-001: the two advisory locks + unapplied/remaining checks must share one transaction; join the caller's only when it is ACTIVE.
    return runInTransaction(this.dataSource, manager, run);
  }

  /** CUS-01 — "Customer Advance / Unapplied Receipt" list: the visible customers' payments that still carry an unapplied balance. */
  async listUnappliedPayments(actorUserId: string, customerId?: string, manager?: EntityManager): Promise<Array<Payment & { unappliedAmount: string; customerCode: string; customerName: string }>> {
    const customers = await this.customers.listCustomers(actorUserId, manager);
    const customerById = new Map(customers.map((c) => [c.id, c]));
    const ids = customerId ? [customerId].filter((id) => customerById.has(id)) : [...customerById.keys()];
    if (ids.length === 0) return [];
    const rows: Array<{ paymentId: string; unapplied: string }> = await (manager ?? this.dataSource).query(
      `SELECT "paymentId", SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END) AS unapplied
       FROM "customer_ledger_entries" WHERE "paymentId" IS NOT NULL AND "invoiceId" IS NULL AND "customerId" = ANY($1)
       GROUP BY "paymentId" HAVING SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END) > 0`,
      [ids],
    );
    if (rows.length === 0) return [];
    const payments = await (manager ?? this.dataSource).getRepository(Payment).find({ where: { id: In(rows.map((r) => r.paymentId)) }, order: { occurredAt: 'DESC' } });
    const unappliedById = new Map(rows.map((r) => [r.paymentId, Number(r.unapplied).toFixed(2)]));
    return payments.map((p) => ({ ...p, unappliedAmount: unappliedById.get(p.id) ?? '0.00', customerCode: customerById.get(p.customerId)?.code ?? '', customerName: customerById.get(p.customerId)?.name ?? '' }));
  }

  async listPaymentsForCustomer(customerId: string, manager?: EntityManager): Promise<Payment[]> {
    return (manager ?? this.dataSource).getRepository(Payment).find({ where: { customerId }, order: { occurredAt: 'DESC' } });
  }

  /** ERP UI Integration (CTO directive) — the "التحصيلات والمدفوعات" list screen, across every customer the caller may see. Scope-filtered via `CustomersService.listCustomers`, same discipline as `InvoiceService.listAllInvoices`. */
  async listAllPayments(
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<Array<Payment & { customerCode: string; customerName: string; invoiceNumber: string | null }>> {
    const customers = await this.customers.listCustomers(actorUserId, manager);
    const customerById = new Map(customers.map((c) => [c.id, c]));
    if (customerById.size === 0) return [];

    const payments = await (manager ?? this.dataSource)
      .getRepository(Payment)
      .find({ where: { customerId: In([...customerById.keys()]) }, order: { occurredAt: 'DESC' } });
    if (payments.length === 0) return [];

    const invoiceIds = [...new Set(payments.map((p) => p.invoiceId).filter((id): id is string => !!id))]; // CUS-01: on-account payments have no invoice
    const invoices = await (manager ?? this.dataSource).getRepository(SalesInvoice).find({ where: { id: In(invoiceIds) } });
    const invoiceNumberById = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));

    return payments.map((p) => ({
      ...p,
      customerCode: customerById.get(p.customerId)?.code ?? '',
      customerName: customerById.get(p.customerId)?.name ?? '',
      invoiceNumber: p.invoiceId ? (invoiceNumberById.get(p.invoiceId) ?? null) : null,
    }));
  }
}
