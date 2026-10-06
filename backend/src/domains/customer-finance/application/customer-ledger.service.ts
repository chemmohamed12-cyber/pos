import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CustomerLedgerEntry } from '../infrastructure/customer-ledger-entry.entity';
import { CustomerLedgerEntryType, LedgerDirection } from '../domain/customer-ledger-entry-type';
import { SALES_CUSTOMERS_CONTRACT, SalesCustomersContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { FinanceCustomerLedgerContract } from '../../../foundation/module-registry/contracts/finance.contract';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';

const LEDGER_ENTRY_DOCUMENT_TYPE = 'customer_ledger_entry';
const LEDGER_ENTRY_PREFIX = 'CLE';

export interface PostLedgerEntryInput {
  customerId: string;
  entryType: CustomerLedgerEntryType;
  direction: LedgerDirection;
  amount: string;
  salesOrderId?: string | null;
  invoiceId?: string | null;
  depositId?: string | null;
  paymentId?: string | null;
  returnCreditId?: string | null;
  shipmentId?: string | null;
  treasuryTransactionId?: string | null;
  reference?: string | null;
  reason?: string | null;
  createdByUserId: string;
}

/**
 * Customer Financial Account / AR (CTO directive) — the Customer Ledger's
 * own service. Mirrors `TreasuryService`'s discipline exactly (append-only
 * rows, balance always derived via `SUM`, reversal via a new offsetting
 * row, never a raw update/delete) applied to a customer-facing subledger
 * instead of a cash/bank account. No controller route exposes `postEntry`/
 * `sweepUnappliedFor` directly — they're called only by other domain
 * services (`InvoiceService`, `PaymentsService`, and the Deposit/COD/
 * Returns bridges), same "no raw client action" precedent as
 * `TreasuryService.createDepositTransaction`.
 */
@Injectable()
export class CustomerLedgerService implements FinanceCustomerLedgerContract {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    @Inject(SALES_CUSTOMERS_CONTRACT) private readonly customers: SalesCustomersContract,
  ) {}

  async postEntry(input: PostLedgerEntryInput, manager?: EntityManager): Promise<CustomerLedgerEntry> {
    if (!Number.isFinite(Number(input.amount)) || Number(input.amount) <= 0) {
      throw new BadRequestException('Ledger entry amount must be a positive number.');
    }

    // Area 21 Operational Company Scoping Retrofit (2026-09-28): `manager`
    // now threaded through — this row is pre-seeded per Company by
    // `AddCustomerFinancialCore`'s own migration, so this call is a
    // guaranteed no-op in practice, but the pre-Area-21 ambient
    // `this.dataSource` call was still the wrong DataSource under Model B
    // (found live via `payments.company-isolation.spec.ts`'s deep-chain
    // `recordPayment` proof — a control-plane DataSource has no
    // `NumberingSequence` metadata at all, so this threw outright rather
    // than silently misrouting).
    await this.numbering.registerDocumentType(LEDGER_ENTRY_DOCUMENT_TYPE, LEDGER_ENTRY_PREFIX, true, manager);
    // Gap Resolution Package 3 (2026-09-14): this call previously did not forward `manager` — a
    // caller-supplied transaction covered the entry save below but not this number draw, leaving one
    // un-threaded write inside an otherwise-atomic operation. `getNextNumber` already supports the
    // additive `manager?` contract; this simply uses it.
    const entryNumber = await this.numbering.getNextNumber(LEDGER_ENTRY_DOCUMENT_TYPE, manager);

    const runner = manager ?? this.dataSource;
    const repo = runner.getRepository(CustomerLedgerEntry);
    const saved = await repo.save(
      repo.create({
        entryNumber,
        customerId: input.customerId,
        entryType: input.entryType,
        direction: input.direction,
        amount: input.amount,
        salesOrderId: input.salesOrderId ?? null,
        invoiceId: input.invoiceId ?? null,
        depositId: input.depositId ?? null,
        paymentId: input.paymentId ?? null,
        returnCreditId: input.returnCreditId ?? null,
        shipmentId: input.shipmentId ?? null,
        treasuryTransactionId: input.treasuryTransactionId ?? null,
        reference: input.reference ?? null,
        reason: input.reason ?? null,
        entryDate: new Date(),
        createdByUserId: input.createdByUserId,
        reversalOfEntryId: null,
        status: 'posted',
      }),
    );

    await this.audit.record(
      {
        actorUserId: input.createdByUserId,
        organizationId: null,
        action: 'customer_finance.ledger_entry.posted',
        resource: 'customer_ledger_entry',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after: { customerId: input.customerId, entryType: input.entryType, direction: input.direction, amount: input.amount, invoiceId: saved.invoiceId },
      },
      manager,
    );

    return saved;
  }

  /**
   * Balance is always derived, never stored — the ledger is the single
   * source of truth (same discipline as `TreasuryService.getAccountBalance`).
   * Deliberately NO `status` filter — same as Treasury: a `reversed`
   * original row stays counted, and its own opposite-direction reversal
   * row cancels it out arithmetically. Filtering `status = 'posted'` here
   * would double-exclude the original while still counting the reversal,
   * leaving a phantom balance (a real bug caught by this class's own
   * unit tests before it ever shipped).
   */
  async getCustomerBalance(customerId: string, manager?: EntityManager): Promise<string> {
    const runner = manager ?? this.dataSource;
    const rows = await runner.query(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END), 0) AS balance
       FROM "customer_ledger_entries" WHERE "customerId" = $1`,
      [customerId],
    );
    return Number(rows[0].balance).toFixed(2);
  }

  /**
   * F04 / handoff F04-H1 (ADR-036 D11, `GetCustomerLedgerBalances`). Every
   * customer's derived AR balance + the grand total, as of an optional
   * date — the read contract F04's AR↔GL reconciliation uses instead of
   * touching this domain's tables directly. Same derive-never-store
   * discipline as `getCustomerBalance`, no `status` filter (a reversal's
   * own opposite row cancels the original).
   */
  /** Multi-Company Area 9 (2026-09-22) — `manager?` added so a company-scoped caller (`ClosingSnapshotService`) can run this against that Company's own connection instead of the ambient one. Falls back to the ambient `this.dataSource` when omitted, unchanged for every existing caller. */
  async getAllCustomerBalances(asOfDate?: string, manager?: EntityManager): Promise<{ balances: Array<{ customerId: string; balance: string }>; total: string }> {
    const runner = manager ?? this.dataSource;
    const params: unknown[] = [];
    let dateClause = '';
    if (asOfDate) {
      params.push(asOfDate);
      // `asOfDate` is a calendar date and is INCLUSIVE of that whole day — the
      // F04 AR↔GL reconciliation compares this against the GL side's
      // `businessDate <= :date` (a DATE column). Comparing a `timestamptz`
      // `entryDate` with `<= '<date>'` would silently drop every same-day entry
      // (they sort after midnight) and manufacture phantom drift for any
      // reconciliation run on the current day. Compare on the date part.
      dateClause = `WHERE "entryDate" < ($1::date + INTERVAL '1 day')`;
    }
    const rows = await runner.query(
      `SELECT "customerId",
              COALESCE(SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END), 0)::numeric(20,4) AS balance
       FROM "customer_ledger_entries" ${dateClause}
       GROUP BY "customerId"
       HAVING COALESCE(SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END), 0) <> 0
       ORDER BY "customerId"`,
      params,
    );
    const [tot] = await runner.query(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END), 0)::numeric(20,4) AS total
       FROM "customer_ledger_entries" ${dateClause}`,
      params,
    );
    return {
      balances: rows.map((r: { customerId: string; balance: string }) => ({ customerId: r.customerId, balance: r.balance })),
      total: tot.total,
    };
  }

  /**
   * The sum of every still-outstanding overdue invoice for this customer —
   * self-contained (queries this domain's own `sales_invoices`/
   * `customer_ledger_entries` tables directly, both owned by
   * customer-finance, never a cross-domain violation). No `status` filter
   * on the applied-credits subquery — same reasoning as `getCustomerBalance`
   * (a reversed entry's own opposite row already cancels it out; filtering
   * by status here would double-exclude it).
   */
  private async getOverdueAmount(customerId: string, manager?: EntityManager): Promise<string> {
    const rows = await (manager ?? this.dataSource).query(
      `SELECT COALESCE(SUM(GREATEST(inv."totalAmount" - COALESCE(applied.total, 0), 0)), 0) AS overdue
       FROM "sales_invoices" inv
       LEFT JOIN (
         SELECT "invoiceId", SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END) AS total
         FROM "customer_ledger_entries"
         WHERE "invoiceId" IS NOT NULL AND "entryType" != 'sales_invoice'
         GROUP BY "invoiceId"
       ) applied ON applied."invoiceId" = inv."id"
       WHERE inv."customerId" = $1 AND inv."dueDate" IS NOT NULL AND inv."dueDate" < now()
         AND (inv."totalAmount" - COALESCE(applied.total, 0)) > 0`,
      [customerId],
    );
    return Number(rows[0].overdue).toFixed(2);
  }

  /** Customer Account Dashboard's header figures (CTO directive §11) — expose-only in this phase, no hard credit-limit enforcement on order creation (disclosed scoping decision, see plan). */
  async getCreditSummary(customerId: string, manager?: EntityManager): Promise<{ balance: string; creditLimit: string | null; availableCredit: string | null; overdueAmount: string }> {
    const [balance, creditLimit, overdueAmount] = await Promise.all([
      this.getCustomerBalance(customerId, manager),
      this.customers.getCreditLimit(customerId, manager),
      this.getOverdueAmount(customerId, manager),
    ]);
    const availableCredit = creditLimit !== null ? (Number(creditLimit) - Number(balance)).toFixed(2) : null;
    return { balance, creditLimit, availableCredit, overdueAmount };
  }

  /**
   * Reversal, never delete or edit (directive: no post-posting edits) —
   * same discipline as `TreasuryService.reverseTransaction`. A single row
   * at a time (Customer Ledger entries, unlike Treasury transfers, never
   * come in linked pairs).
   */
  async reverseEntry(entryId: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<CustomerLedgerEntry> {
    const repo = (manager ?? this.dataSource).getRepository(CustomerLedgerEntry);
    const original = await repo.findOne({ where: { id: entryId } });
    if (!original) throw new NotFoundException(`Customer ledger entry "${entryId}" not found.`);
    if (original.status !== 'posted') {
      throw new ConflictException(`Cannot reverse a ledger entry in status "${original.status}".`);
    }

    await this.numbering.registerDocumentType(LEDGER_ENTRY_DOCUMENT_TYPE, LEDGER_ENTRY_PREFIX, undefined, manager);
    const entryNumber = await this.numbering.getNextNumber(LEDGER_ENTRY_DOCUMENT_TYPE, manager);

    const reversal = await (manager ?? this.dataSource.manager).transaction(async (manager) => {
      const mRepo = manager.getRepository(CustomerLedgerEntry);
      const saved = await mRepo.save(
        mRepo.create({
          entryNumber,
          customerId: original.customerId,
          entryType: original.entryType,
          direction: original.direction === 'debit' ? 'credit' : 'debit',
          amount: original.amount,
          salesOrderId: original.salesOrderId,
          invoiceId: original.invoiceId,
          depositId: original.depositId,
          paymentId: original.paymentId,
          returnCreditId: original.returnCreditId,
          shipmentId: original.shipmentId,
          treasuryTransactionId: original.treasuryTransactionId,
          reference: original.reference,
          reason: `Reversal: ${reason}`,
          entryDate: new Date(),
          createdByUserId: actorUserId,
          reversalOfEntryId: original.id,
          status: 'posted',
        }),
      );
      await mRepo.update(original.id, { status: 'reversed' });
      return saved;
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'customer_finance.ledger_entry.reversed',
      resource: 'customer_ledger_entry',
      resourceId: original.id,
      result: 'success',
      correlationId: null,
      before: { status: 'posted' },
      after: { status: 'reversed', reversalEntryId: reversal.id, reason },
    }, manager);

    return reversal;
  }

  async listLedger(customerId: string, filters?: { entryType?: string; from?: string; to?: string }, manager?: EntityManager): Promise<CustomerLedgerEntry[]> {
    const repo = (manager ?? this.dataSource).getRepository(CustomerLedgerEntry);
    const qb = repo.createQueryBuilder('e').where('e.customerId = :customerId', { customerId });
    if (filters?.entryType) qb.andWhere('e.entryType = :entryType', { entryType: filters.entryType });
    if (filters?.from) qb.andWhere('e.entryDate >= :from', { from: filters.from });
    if (filters?.to) qb.andWhere('e.entryDate <= :to', { to: filters.to });
    qb.orderBy('e.entryDate', 'ASC').addOrderBy('e.createdAt', 'ASC');
    return qb.getMany();
  }

  /**
   * Backfills an invoice link onto every still-unapplied ledger entry for
   * this customer+order — the one narrow, disclosed exception to
   * immutability (see the entity's own doc comment on `invoiceId`). Called
   * by `InvoiceService.postInvoice` right after the invoice's own debit is
   * posted, so an early deposit or a COD collection remitted before
   * invoicing correctly nets against the new invoice's AR.
   */
  /**
   * Gap Resolution Package 3 (2026-09-14): `manager?` added so `InvoiceService.postInvoice` can run
   * this sweep inside its own transaction alongside the invoice debit it always accompanies —
   * previously this was a standalone, independently-committing write (part of rows 18/33/34's class
   * of gap). Falls back to `dataSource` for the one existing standalone caller (none besides
   * `postInvoice` today — kept optional/backward-compatible per the codebase's own convention).
   */
  async sweepUnappliedFor(customerId: string, salesOrderId: string, invoiceId: string, manager?: EntityManager): Promise<void> {
    const runner = manager ?? this.dataSource;
    await runner
      .createQueryBuilder()
      .update(CustomerLedgerEntry)
      .set({ invoiceId })
      // CUS-01: an unapplied remainder of a payment that already has explicit applications (`payment_application` rows) is NEVER swept —
      // it is settled only by an explicit apply, so a partially applied receipt cannot be applied twice.
      .where(
        `"customerId" = :customerId AND "salesOrderId" = :salesOrderId AND "invoiceId" IS NULL AND "status" = :status
         AND ("paymentId" IS NULL OR NOT EXISTS (SELECT 1 FROM "customer_ledger_entries" a WHERE a."paymentId" = "customer_ledger_entries"."paymentId" AND a."entryType" = 'payment_application'))`,
        {
        customerId,
        salesOrderId,
        status: 'posted',
        },
      )
      .execute();
  }

  /**
   * ERP UI Integration (CTO directive) — backs the "حسابات العملاء"
   * (Customer Accounts) list and the "العملاء والحسابات" section cover's
   * KPIs. Reuses `CustomersService.listCustomers` (already Scope-filtered
   * — a plain rep sees only their own customers, a reviewer role sees all,
   * same "no direct source" precedent every other cross-domain aggregate
   * in this codebase follows) rather than re-deriving visibility here.
   * One aggregate SQL query, not N calls — the balance formula itself is
   * identical to `getCustomerBalance`, just grouped.
   */
  async getBalancesForVisibleCustomers(actorUserId: string, manager?: EntityManager): Promise<Array<{ customerId: string; balance: string }>> {
    const customers = await this.customers.listCustomers(actorUserId, manager);
    const ids = customers.map((c) => c.id);
    if (ids.length === 0) return [];

    const rows = await (manager ?? this.dataSource).query(
      `SELECT "customerId", COALESCE(SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END), 0) AS balance
       FROM "customer_ledger_entries" WHERE "customerId" = ANY($1) GROUP BY "customerId"`,
      [ids],
    );
    const balanceByCustomerId = new Map<string, string>(rows.map((r: { customerId: string; balance: string }) => [r.customerId, Number(r.balance).toFixed(2)]));
    return ids.map((id) => ({ customerId: id, balance: balanceByCustomerId.get(id) ?? '0.00' }));
  }
}
