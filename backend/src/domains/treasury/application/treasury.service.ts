import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { utcDayEndExclusiveSql } from '../../../foundation/localization/business-date';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, ILike, In } from 'typeorm';
import { TreasuryAccount } from '../infrastructure/treasury-account.entity';
import { TreasuryAccountType } from '../infrastructure/treasury-account-type.entity';
import { TreasuryTransaction, TreasuryTransactionType } from '../infrastructure/treasury-transaction.entity';
import { canTransitionTreasuryAccountStatus, TreasuryAccountStatus } from '../domain/treasury-account-status';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { FinanceTreasuryContract, TreasuryLedgerEntryView } from '../../../foundation/module-registry/contracts/finance.contract';
import {
  CashRecordedEvent,
  TransferCompletedEvent,
  TREASURY_EVENT_TOPICS,
} from '../../../foundation/module-registry/contracts/treasury-events.contract';
import { ScopeResolver } from '../../../foundation/scope/scope-resolver.service';
import { runInTransaction } from '../../../foundation/transaction/run-in-transaction';

const NUMBERING_SERIES: Record<TreasuryTransactionType, string> = {
  cash_in: 'treasury_cash_in',
  cash_out: 'treasury_cash_out',
  transfer_out: 'treasury_transfer',
  transfer_in: 'treasury_transfer',
};

/** F06-H1 (ADR-038 D4) — the emit decision is structural: only the `*Direct` methods pass `true`. */
interface GlEmitOpts {
  emitGlEvent: boolean;
  /** Reversals only: when the account is unmapped skip the event (mirrors an original that never had one) instead of refusing. */
  mirrorUnmapped?: boolean;
  /** T3: posting-profile reference for the counter account of a direct cash movement (see CashRecordedEvent.counterConfigKey). */
  counter?: { configKey: string; reasonCode: string };
}
const NO_EMIT: GlEmitOpts = { emitGlEvent: false };
/** Treasury integrity (T1, G-04): a reversal MIRRORS its original — a legacy leg on an unmapped account never had a GL effect, so its reversal must not invent one (and must not fail). */
const EMIT_MIRROR: GlEmitOpts = { emitGlEvent: true, mirrorUnmapped: true };

/**
 * Financial/Treasury Core — a real ledger-backed foundation (accounts +
 * append-only transactions), not a "safe" bolted onto Sales Orders. This
 * is the one place account balances are computed; nothing else in the
 * codebase writes a balance field, because there isn't one — every
 * balance is `SUM` over this domain's own ledger, the same discipline
 * Warehouse already uses for stock (`on hand` from `stock_movements`).
 *
 * **F06 / F06-H1 (ADR-038):** the two routine cash-movement topics
 * (`treasury.cash.recorded` / `treasury.transfer.completed`) that F03's
 * dormant handlers already consume are now really published — via the
 * Transactional Outbox, in the SAME `dataSource.transaction` as the
 * ledger write, and **only when a Treasury account is GL-mapped
 * (`glAccountCode`)**. The emit is **structurally** confined to the
 * controller-facing `*Direct` methods: the `FinanceTreasuryContract`
 * methods (`cashIn` / `transfer` / `createDepositTransaction`, invoked by
 * deposit-control / customer-finance / delivery) call the private `*Core`
 * with `emitGlEvent: false` hard-wired — a domain on the contract path
 * cannot cause a publish (those flows own their GL story:
 * `finance.payment.recorded` today, `deposit.verified` /
 * `collection.recorded` in F09).
 */
@Injectable()
export class TreasuryService implements FinanceTreasuryContract {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly scope: ScopeResolver,
    private readonly events: EventBusService,
  ) {}

  async createAccountType(code: string, name: string, actorUserId: string, manager?: EntityManager): Promise<TreasuryAccountType> {
    const repo = (manager ?? this.dataSource).getRepository(TreasuryAccountType);
    const existing = await repo.findOne({ where: { code } });
    if (existing) throw new ConflictException(`Treasury account type code "${code}" is already in use.`);

    const saved = await repo.save(repo.create({ code, name }));
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'treasury.account_type.created',
        resource: 'treasury_account_type',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after: { code, name },
      },
      manager,
    );
    return saved;
  }

  async listAccountTypes(manager?: EntityManager): Promise<TreasuryAccountType[]> {
    return (manager ?? this.dataSource).getRepository(TreasuryAccountType).find({ order: { code: 'ASC' } });
  }

  async getAccountType(accountTypeId: string, manager?: EntityManager): Promise<TreasuryAccountType> {
    const type = await (manager ?? this.dataSource).getRepository(TreasuryAccountType).findOne({ where: { id: accountTypeId } });
    if (!type) throw new NotFoundException(`Treasury account type "${accountTypeId}" not found.`);
    return type;
  }

  async createAccount(code: string, name: string, accountTypeId: string, actorUserId: string, manager?: EntityManager): Promise<TreasuryAccount> {
    const repo = (manager ?? this.dataSource).getRepository(TreasuryAccount);
    const existing = await repo.findOne({ where: { code } });
    if (existing) throw new ConflictException(`Treasury account code "${code}" is already in use.`);
    await this.getAccountType(accountTypeId, manager); // 404s if the type doesn't exist — never silently accept an orphan type id

    const saved = await repo.save(repo.create({ code, name, accountTypeId }));
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'treasury.account.created',
        resource: 'treasury_account',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after: { code, name, accountTypeId },
      },
      manager,
    );
    return saved;
  }

  async getAccount(accountId: string, manager?: EntityManager): Promise<TreasuryAccount> {
    const account = await (manager ?? this.dataSource).getRepository(TreasuryAccount).findOne({ where: { id: accountId } });
    if (!account) throw new NotFoundException(`Treasury account "${accountId}" not found.`);
    return account;
  }

  async setAccountStatus(accountId: string, status: TreasuryAccountStatus, actorUserId: string, manager?: EntityManager): Promise<TreasuryAccount> {
    const repo = (manager ?? this.dataSource).getRepository(TreasuryAccount);
    const account = await this.getAccount(accountId, manager);
    if (!canTransitionTreasuryAccountStatus(account.status, status)) {
      throw new ConflictException(`Cannot transition treasury account "${accountId}" from "${account.status}" to "${status}".`);
    }
    account.status = status;
    const saved = await repo.save(account);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: `treasury.account.${status === 'active' ? 'activated' : 'deactivated'}`,
        resource: 'treasury_account',
        resourceId: accountId,
        result: 'success',
        correlationId: null,
        after: { status },
      },
      manager,
    );
    return saved;
  }

  /**
   * F06 / F06-H1 (ADR-038 D7). Map a Treasury account to its GL account
   * (`GLAccount.code`, a `bank` control account), or clear the mapping
   * (`glAccountCode = null`). Treasury deliberately does NOT validate the
   * code against the chart — that stays an `accounting` concern; an
   * invalid code makes the GL `FinancialEvent` fail closed (a typed
   * rejection, visible + re-drivable), never a bad posting.
   */
  /**
   * D2 (2026-10-04): GL mapping is mandatory at the first FINANCIAL POSTING from an account, not at creation.
   * Rejects an unmapped account (409) before the caller mutates anything; returns the mapped code otherwise.
   * Whether that code still resolves to an active postable chart account is the Financial Event handler's
   * fail-closed check (Treasury does not read the chart — ADR boundary; `AccountingModule` imports `TreasuryModule`).
   */
  async requireGlMappedAccount(accountId: string, manager?: EntityManager): Promise<{ glAccountCode: string }> {
    const account = await this.getAccount(accountId, manager);
    const code = account.glAccountCode?.trim();
    if (!code) {
      throw new ConflictException(`Treasury account "${account.code}" is not GL-mapped — map it to a GL account before any financial posting.`);
    }
    return { glAccountCode: code };
  }

  async setAccountGlMapping(accountId: string, glAccountCode: string | null, actorUserId: string, manager?: EntityManager): Promise<TreasuryAccount> {
    const repo = (manager ?? this.dataSource).getRepository(TreasuryAccount);
    const account = await this.getAccount(accountId, manager);
    const normalized = glAccountCode && glAccountCode.trim() !== '' ? glAccountCode.trim() : null;
    account.glAccountCode = normalized;
    const saved = await repo.save(account);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'treasury.account.gl_mapping_set',
        resource: 'treasury_account',
        resourceId: accountId,
        result: 'success',
        correlationId: null,
        after: { glAccountCode: normalized },
      },
      manager,
    );
    return saved;
  }

  /** Balance is always derived, never stored — the ledger is the single source of truth. */
  async getAccountBalance(accountId: string, manager?: EntityManager): Promise<string> {
    const runner = manager ?? this.dataSource;
    const rows = await runner.query(
      `SELECT COALESCE(SUM(CASE WHEN "type" IN ('cash_in','transfer_in') THEN "amount" ELSE -"amount" END), 0) AS balance
       FROM "treasury_transactions" WHERE "treasuryAccountId" = $1`,
      [accountId],
    );
    return Number(rows[0].balance).toFixed(2);
  }

  /**
   * ADR-031 / AUDIT-SEC-03 remediation (Treasury — F3). `requestingUserId`
   * is now REQUIRED: results are filtered through `ScopeResolver` before
   * being returned. On every existing single-branch installation this is a
   * no-op (every account's `orgUnitId` is null until a customer builds an
   * org tree) — behaviour-identical until that happens, by construction.
   */
  /**
   * `search` (Smart Lookup UX initiative — canonical `?search=` contract,
   * same shape as `CustomersController`/`AccountingController`'s account
   * search): case-insensitive, partial, matched against code OR name,
   * applied at the DB query so a filtered call never computes balances
   * for rows it will just discard. Omitted, behaviour is byte-for-byte
   * identical to before — every existing caller (the Treasury Accounts
   * screen, the Deposit Control panel) is unaffected.
   */
  async listAccountsWithBalances(
    requestingUserId: string,
    options?: { search?: string },
    manager?: EntityManager,
  ): Promise<Array<TreasuryAccount & { balance: string; accountTypeCode: string; accountTypeName: string }>> {
    const search = options?.search?.trim();
    const accounts = await (manager ?? this.dataSource).getRepository(TreasuryAccount).find({
      where: search ? [{ code: ILike(`%${search}%`) }, { name: ILike(`%${search}%`) }] : {},
      order: { code: 'ASC' },
    });
    const allowed = await this.scope.filterAllowedByOrgUnit(requestingUserId, accounts, manager);
    const types = await this.listAccountTypes(manager);
    const typeById = new Map(types.map((t) => [t.id, t]));
    return Promise.all(
      allowed.map(async (a) => ({
        ...a,
        balance: await this.getAccountBalance(a.id, manager),
        accountTypeCode: typeById.get(a.accountTypeId)?.code ?? '',
        accountTypeName: typeById.get(a.accountTypeId)?.name ?? '',
      })),
    );
  }

  /**
   * F06 / F06-H1 (ADR-038 D9). Every Treasury account's derived operational
   * balance + its `glAccountCode`, as of an optional date (inclusive of
   * the whole calendar day — symmetric with the GL side's DATE semantics,
   * the F04 lesson). Raw SQL `NUMERIC` — no JS `Number` round-trip, so
   * F06's Cash/Bank↔GL reconciliation equality check is exact (ADR-035 D4).
   */
  /** Multi-Company Area 9 (2026-09-22) — `manager?` added so a company-scoped caller (`ClosingSnapshotService`) can run this against that Company's own connection instead of the ambient one. Falls back to the ambient `this.dataSource` when omitted, unchanged for every existing caller. */
  async getAllTreasuryBalances(asOfDate?: string, manager?: EntityManager): Promise<{
    balances: Array<{ treasuryAccountId: string; code: string; name: string; glAccountCode: string | null; balance: string }>;
  }> {
    // NB: no `status` filter — a reversed row and its offsetting reversal
    // leg net to zero, exactly as `getAccountBalance` computes it. Filtering
    // to 'posted' would drop the reversed row but keep the reversal leg,
    // double-counting the correction.
    //
    // The as-of comparison is an exclusive UTC-day-end bound on the `timestamptz`
    // movementDate — symmetric with the GL side's `businessDate` (a DATE column,
    // stamped with the UTC date) `<= to`. Neither a session-TZ `::date` cast nor a
    // bare `($1::date + INTERVAL '1 day')` is safe: with the session TZ ahead of UTC
    // (Africa/Cairo) a movement at 00:00-03:00 local falls on the NEXT local day but
    // the GL journal carries the previous UTC date -> phantom drift
    // (see foundation/localization/business-date.ts).
    const runner = manager ?? this.dataSource;
    const dateClause = asOfDate ? `AND t."movementDate" < ${utcDayEndExclusiveSql('$1')}` : '';
    const params: string[] = asOfDate ? [asOfDate] : [];
    const rows = (await runner.query(
      `SELECT a."id" AS "treasuryAccountId", a."code", a."name", a."glAccountCode",
              COALESCE(SUM(CASE WHEN t."type" IN ('cash_in','transfer_in') THEN t."amount" ELSE -t."amount" END), 0)::numeric(20,4) AS "balance"
         FROM "treasury_accounts" a
         LEFT JOIN "treasury_transactions" t
           ON t."treasuryAccountId" = a."id" ${dateClause}
        GROUP BY a."id", a."code", a."name", a."glAccountCode"
        ORDER BY a."code" ASC`,
      params,
    )) as Array<{ treasuryAccountId: string; code: string; name: string; glAccountCode: string | null; balance: string }>;
    return { balances: rows };
  }

  /** F06 — one Treasury account's operational ledger rows (Cash/Bank position statement). */
  async listTreasuryLedger(
    treasuryAccountId: string,
    filter?: { from?: string; to?: string },
    manager?: EntityManager,
  ): Promise<TreasuryLedgerEntryView[]> {
    const qb = (manager ?? this.dataSource)
      .getRepository(TreasuryTransaction)
      .createQueryBuilder('t')
      .where('t."treasuryAccountId" = :id', { id: treasuryAccountId });
    if (filter?.from) qb.andWhere('t."movementDate"::date >= :from::date', { from: filter.from });
    if (filter?.to) qb.andWhere('t."movementDate"::date <= :to::date', { to: filter.to });
    const rows = await qb.orderBy('t."movementDate"', 'ASC').addOrderBy('t."createdAt"', 'ASC').getMany();
    return rows.map((t) => ({
      transactionNumber: t.transactionNumber,
      type: t.type,
      amount: t.amount,
      movementDate: t.movementDate instanceof Date ? t.movementDate.toISOString() : String(t.movementDate),
      reference: t.reference,
      reason: t.reason,
      status: t.status,
    }));
  }

  /** AUDIT-SEC-03 remediation: the ledger-by-account read path — a caller may only view a specific account's ledger if `ScopeResolver` allows it. */
  async assertLedgerAccountAccess(accountId: string, requestingUserId: string, manager?: EntityManager): Promise<void> {
    const account = await this.getAccount(accountId, manager);
    await this.scope.assertAccess(requestingUserId, 'treasury_account', accountId, account.orgUnitId, manager);
  }

  /**
   * AUDIT-SEC-28 remediation (S21 — Security Assurance Gate, 2026-09-10,
   * found by an independent sweep for the exact AUDIT-SEC-27 gap shape):
   * `reverseTransaction`/the controller's own `POST .../reverse` route
   * was gated only by `@RequirePermission('finance', 'editable')` — no
   * Scope check at all, unlike the sibling `ledger` READ path
   * (`assertLedgerAccountAccess` above), which already respects the
   * `treasury_account`'s `org_unit` scope. Resolves the transaction's
   * owning account and delegates to the SAME scope-check the ledger read
   * already uses, so a write can never reach further than a read already
   * could.
   */
  async assertTransactionAccess(transactionId: string, requestingUserId: string, manager?: EntityManager): Promise<void> {
    const txn = await (manager ?? this.dataSource).getRepository(TreasuryTransaction).findOne({ where: { id: transactionId } });
    if (!txn) throw new NotFoundException(`Treasury transaction "${transactionId}" not found.`);
    await this.assertLedgerAccountAccess(txn.treasuryAccountId, requestingUserId, manager);
  }

  /** T1 (G-04): a Treasury-owned movement (the `*Direct` paths) needs a GL owner — checked FIRST, before locks/balance/insert, so the user sees the real reason and nothing is touched. */
  private assertGlOwnerMapped(account: TreasuryAccount, opts: GlEmitOpts): void {
    if (opts.emitGlEvent && !opts.mirrorUnmapped && !account.glAccountCode?.trim()) {
      throw new ConflictException(`Treasury account "${account.code}" is not GL-mapped — map it to a GL account before recording this movement. Nothing was recorded.`);
    }
  }

  private assertActive(account: TreasuryAccount): void {
    if (account.status !== 'active') {
      throw new ConflictException(`Treasury account "${account.code}" is inactive — no new transactions can target it.`);
    }
  }

  private async assertSufficientBalance(manager: EntityManager, accountId: string, amount: string): Promise<void> {
    const available = Number(await this.getAccountBalance(accountId, manager));
    const requested = Number(amount);
    if (requested > available) {
      throw new ConflictException(
        `Insufficient treasury balance: requested ${requested.toFixed(2)}, available ${available.toFixed(2)}, short by ${(requested - available).toFixed(2)}.`,
      );
    }
  }

  private async insertLeg(
    manager: EntityManager,
    input: {
      type: TreasuryTransactionType;
      treasuryAccountId: string;
      amount: string;
      customerId: string | null;
      salesOrderId: string | null;
      /** OP-Procurement/AP Blueprint, Decision 1 (Option A) — optional; omitted by every pre-existing caller. */
      supplierId?: string | null;
      supplierInvoiceId?: string | null;
      /** ADR-070 §9 — optional; omitted by every pre-existing caller. */
      employeeId?: string | null;
      payrollRunId?: string | null;
      depositId: string | null;
      transferGroupId: string | null;
      reference: string | null;
      reason: string | null;
      movementDate: Date;
      createdByUserId: string;
      reversalOfTransactionId: string | null;
    },
  ): Promise<TreasuryTransaction> {
    const transactionNumber = await this.numbering.getNextNumber(NUMBERING_SERIES[input.type], manager);
    const repo = manager.getRepository(TreasuryTransaction);
    return repo.save(repo.create({ ...input, transactionNumber }));
  }

  // ---------------------------------------------------------------------------
  // F06-H1 — Transactional-Outbox publishers (in the caller's transaction)
  // ---------------------------------------------------------------------------

  /** Publish `treasury.cash.recorded` — only when `opts.emitGlEvent` AND the account is GL-mapped. */
  private async emitCashRecorded(
    manager: EntityManager,
    args: { txn: TreasuryTransaction; account: TreasuryAccount; direction: 'in' | 'out'; reversalOf: string | null },
    opts: GlEmitOpts,
  ): Promise<void> {
    if (!opts.emitGlEvent) return;
    if (!args.account.glAccountCode) {
      // G-04: a Treasury-owned movement with no GL owner is refused (409) rather than silently skipping the event; only a reversal of a legacy unmapped leg mirrors "no GL".
      if (opts.mirrorUnmapped) return;
      throw new ConflictException(`Treasury account "${args.account.code}" is not GL-mapped — map it to a GL account before recording this movement. Nothing was recorded.`);
    }
    const payload: CashRecordedEvent = {
      idempotencyKey: `treasury:txn:${args.txn.id}:recorded`,
      businessDate: (args.txn.movementDate instanceof Date ? args.txn.movementDate : new Date(args.txn.movementDate)).toISOString().slice(0, 10),
      orgUnitId: args.account.orgUnitId,
      currency: 'EGP',
      sourceEntityType: 'treasury_transaction',
      sourceEntityId: args.txn.id,
      externalDocument: null,
      payloadVersion: 1,
      accountCode: args.account.glAccountCode,
      amount: args.txn.amount,
      direction: args.direction,
      counterAccountCode: null,
      counterConfigKey: opts.counter?.configKey ?? null,
      counterReasonCode: opts.counter?.reasonCode ?? null,
      treasuryTransactionId: args.txn.id,
      reversalOf: args.reversalOf,
      reference: args.txn.reference,
      reason: args.txn.reason,
    };
    await this.events.publish(manager, TREASURY_EVENT_TOPICS.cashRecorded, payload as unknown as Record<string, unknown>);
  }

  /** Publish `treasury.transfer.completed` — only when `opts.emitGlEvent` AND BOTH accounts are GL-mapped. */
  private async emitTransferCompleted(
    manager: EntityManager,
    args: {
      out: TreasuryTransaction;
      in: TreasuryTransaction;
      source: TreasuryAccount;
      destination: TreasuryAccount;
      transferGroupId: string;
      reversalOf: string | null;
    },
    opts: GlEmitOpts,
  ): Promise<void> {
    if (!opts.emitGlEvent) return;
    if (!args.source.glAccountCode || !args.destination.glAccountCode) {
      if (opts.mirrorUnmapped) return;
      const missing = !args.source.glAccountCode ? args.source.code : args.destination.code;
      throw new ConflictException(`Treasury account "${missing}" is not GL-mapped — both accounts of a transfer must be mapped to a GL account. Nothing was recorded.`);
    }
    const payload: TransferCompletedEvent = {
      idempotencyKey: `treasury:transfer:${args.transferGroupId}:completed`,
      businessDate: (args.out.movementDate instanceof Date ? args.out.movementDate : new Date(args.out.movementDate)).toISOString().slice(0, 10),
      orgUnitId: args.source.orgUnitId ?? args.destination.orgUnitId,
      currency: 'EGP',
      sourceEntityType: 'treasury_transaction',
      sourceEntityId: args.out.id,
      externalDocument: null,
      payloadVersion: 1,
      amount: args.out.amount,
      fromAccountCode: args.source.glAccountCode,
      toAccountCode: args.destination.glAccountCode,
      transferGroupId: args.transferGroupId,
      outTransactionId: args.out.id,
      inTransactionId: args.in.id,
      reversalOf: args.reversalOf,
      reference: args.out.reference,
    };
    await this.events.publish(manager, TREASURY_EVENT_TOPICS.transferCompleted, payload as unknown as Record<string, unknown>);
  }

  // ---------------------------------------------------------------------------
  // Cash In / Out — `*Core` holds the logic + the (conditional) publish;
  // the public `cashIn`/`cashOut` (contract) never emit; only `*Direct` do.
  // ---------------------------------------------------------------------------

  /**
   * F09-H3 (ADR-042 D3c) — the additive-manager convention already used five times in this
   * codebase (`NumberingService`, `AuditService`, `ProcessEngineService`,
   * `InventoryService.recordMovement`, `JournalEntryService.createEntry`/`postEntry`, ADR-041
   * D18a), applied here: when a caller supplies its own `manager`, run inside it (no new
   * BEGIN/COMMIT); when omitted, behave exactly as before this method existed.
   */
  private run<T>(manager: EntityManager | undefined, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    // F-TRS-001: a plain manager (no open transaction) must not run the per-account advisory lock + balance check outside one transaction; join only an ACTIVE caller transaction.
    return runInTransaction(this.dataSource, manager, fn);
  }

  private async cashInCore(
    accountId: string,
    amount: string,
    customerId: string | null,
    salesOrderId: string | null,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    opts: GlEmitOpts,
    manager?: EntityManager,
  ): Promise<TreasuryTransaction> {
    if (Number(amount) <= 0) throw new BadRequestException('Amount must be positive.');
    const account = await this.getAccount(accountId, manager);
    this.assertActive(account);
    this.assertGlOwnerMapped(account, opts);

    const txn = await this.run(manager, async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${accountId}`]);
      const leg = await this.insertLeg(m, {
        type: 'cash_in',
        treasuryAccountId: accountId,
        amount,
        customerId,
        salesOrderId,
        depositId: null,
        transferGroupId: null,
        reference,
        reason,
        movementDate: new Date(),
        createdByUserId: actorUserId,
        reversalOfTransactionId: null,
      });
      await this.emitCashRecorded(m, { txn: leg, account, direction: 'in', reversalOf: null }, opts);
      return leg;
    });
    // A caller-supplied manager means the caller owns the atomic unit (and, per ADR-042 D3c, its
    // own outbox row alongside this leg) — dispatching before that unit even commits would be
    // premature, so this only fires on the no-manager (standalone) path, same as `opts.emitGlEvent`
    // already gates it below.
    if (opts.emitGlEvent) await this.events.dispatchAfterCommit(manager);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'treasury.cash_in',
        resource: 'treasury_transaction',
        resourceId: txn.id,
        result: 'success',
        correlationId: null,
        after: { accountId, amount, customerId, salesOrderId, direct: opts.emitGlEvent },
      },
      manager,
    );
    return txn;
  }

  /**
   * ADR-048 (Procurement) — the same additive-manager fix `cashInCore` already
   * received under F09-H3 (ADR-042 D3c), applied to `cashOutCore`: `SupplierPaymentService`
   * needs its Treasury leg, `Payment` row, and Supplier Ledger debit entry to commit or roll
   * back together, the same atomicity `PaymentsService.recordPayment` already gets from
   * `cashIn`. Previously `cashOutCore` always opened its own transaction — every existing
   * caller (no manager supplied) is unaffected.
   */
  private async cashOutCore(
    accountId: string,
    amount: string,
    customerId: string | null,
    salesOrderId: string | null,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    opts: GlEmitOpts,
    manager?: EntityManager,
    supplierRef?: { supplierId: string | null; supplierInvoiceId: string | null },
    payrollRef?: { employeeId: string | null; payrollRunId: string | null },
  ): Promise<TreasuryTransaction> {
    if (Number(amount) <= 0) throw new BadRequestException('Amount must be positive.');
    const account = await this.getAccount(accountId, manager);
    this.assertActive(account);
    this.assertGlOwnerMapped(account, opts);

    const txn = await this.run(manager, async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${accountId}`]);
      await this.assertSufficientBalance(m, accountId, amount);
      const leg = await this.insertLeg(m, {
        type: 'cash_out',
        treasuryAccountId: accountId,
        amount,
        customerId,
        salesOrderId,
        supplierId: supplierRef?.supplierId ?? null,
        supplierInvoiceId: supplierRef?.supplierInvoiceId ?? null,
        employeeId: payrollRef?.employeeId ?? null,
        payrollRunId: payrollRef?.payrollRunId ?? null,
        depositId: null,
        transferGroupId: null,
        reference,
        reason,
        movementDate: new Date(),
        createdByUserId: actorUserId,
        reversalOfTransactionId: null,
      });
      await this.emitCashRecorded(m, { txn: leg, account, direction: 'out', reversalOf: null }, opts);
      return leg;
    });
    if (opts.emitGlEvent) await this.events.dispatchAfterCommit(manager);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'treasury.cash_out',
        resource: 'treasury_transaction',
        resourceId: txn.id,
        result: 'success',
        correlationId: null,
        after: {
          accountId,
          amount,
          customerId,
          salesOrderId,
          supplierId: supplierRef?.supplierId ?? null,
          supplierInvoiceId: supplierRef?.supplierInvoiceId ?? null,
          employeeId: payrollRef?.employeeId ?? null,
          payrollRunId: payrollRef?.payrollRunId ?? null,
          direct: opts.emitGlEvent,
        },
      },
      manager,
    );
    return txn;
  }

  private async transferCore(
    sourceAccountId: string,
    destinationAccountId: string,
    amount: string,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    opts: GlEmitOpts,
    manager?: EntityManager,
  ): Promise<{ out: TreasuryTransaction; in: TreasuryTransaction }> {
    if (Number(amount) <= 0) throw new BadRequestException('Amount must be positive.');
    if (sourceAccountId === destinationAccountId) throw new BadRequestException('Source and destination accounts must differ.');
    const [source, destination] = await Promise.all([this.getAccount(sourceAccountId, manager), this.getAccount(destinationAccountId, manager)]);
    this.assertActive(source);
    this.assertActive(destination);
    this.assertGlOwnerMapped(source, opts);
    this.assertGlOwnerMapped(destination, opts);

    const transferGroupId = randomUUID();
    const movementDate = new Date();
    // Sorted lock ordering (deadlock safety) — same pattern as Warehouse's multi-pair advisory locks.
    const sortedIds = [sourceAccountId, destinationAccountId].sort();

    const { out, in: inLeg } = await this.run(manager, async (m) => {
      for (const id of sortedIds) {
        await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${id}`]);
      }
      await this.assertSufficientBalance(m, sourceAccountId, amount);

      const outLeg = await this.insertLeg(m, {
        type: 'transfer_out',
        treasuryAccountId: sourceAccountId,
        amount,
        customerId: null,
        salesOrderId: null,
        depositId: null,
        transferGroupId,
        reference,
        reason,
        movementDate,
        createdByUserId: actorUserId,
        reversalOfTransactionId: null,
      });
      const inLegRow = await this.insertLeg(m, {
        type: 'transfer_in',
        treasuryAccountId: destinationAccountId,
        amount,
        customerId: null,
        salesOrderId: null,
        depositId: null,
        transferGroupId,
        reference,
        reason,
        movementDate,
        createdByUserId: actorUserId,
        reversalOfTransactionId: null,
      });
      await this.emitTransferCompleted(
        m,
        { out: outLeg, in: inLegRow, source, destination, transferGroupId, reversalOf: null },
        opts,
      );
      return { out: outLeg, in: inLegRow };
    });
    if (opts.emitGlEvent) await this.events.dispatchAfterCommit(manager);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'treasury.transfer',
        resource: 'treasury_transaction',
        resourceId: out.id,
        result: 'success',
        correlationId: null,
        after: { sourceAccountId, destinationAccountId, amount, transferGroupId },
      },
      manager,
    );
    return { out, in: inLeg };
  }

  /**
   * Manual Cash In — `FinanceTreasuryContract` method. Invoked by
   * customer-finance (a customer payment leg) / delivery (a COD custody
   * leg / settlement leg) via `FINANCE_TREASURY_CONTRACT`. **Never publishes a
   * `treasury.*` GL event** (ADR-038 D4) — those callers own their GL
   * story. The Treasury UI uses `cashInDirect` instead.
   *
   * F09-H3 (ADR-042 D3c) — additive optional trailing `manager?`: when supplied (e.g.
   * `DeliveryService.remitCollection`), this leg is written inside the CALLER's own transaction, so
   * it commits or rolls back together with whatever else that caller is doing atomically.
   */
  async cashIn(
    accountId: string,
    amount: string,
    customerId: string | null,
    salesOrderId: string | null,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<TreasuryTransaction> {
    return this.cashInCore(accountId, amount, customerId, salesOrderId, reference, reason, actorUserId, NO_EMIT, manager);
  }

  /** Manual Cash Out — same non-emitting contract semantics as `cashIn`, including the additive `manager?` (ADR-048). */
  async cashOut(
    accountId: string,
    amount: string,
    customerId: string | null,
    salesOrderId: string | null,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<TreasuryTransaction> {
    return this.cashOutCore(accountId, amount, customerId, salesOrderId, reference, reason, actorUserId, NO_EMIT, manager);
  }

  /**
   * Supplier Cash Out — OP-Procurement/AP Blueprint §8, CTO ratification
   * Decision 1: **APPROVED — Option A** (extend, not generalize;
   * Option B — a generic `{counterpartyType, counterpartyId}` refactor of
   * `cashOutCore` — is a disclosed future refactor, explicitly out of
   * scope). A parallel overload alongside `cashOut`, delegating to the
   * SAME private `cashOutCore`, so `SupplierPaymentService` calls this
   * through `FINANCE_TREASURY_CONTRACT` instead of injecting the concrete
   * `TreasuryService` directly. Same non-emitting contract semantics and
   * additive `manager?` as `cashOut`/`cashIn`.
   */
  async cashOutForCustodyExpense(
    accountId: string,
    amount: string,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    manager: EntityManager,
    counter: { configKey: string; reasonCode: string },
  ): Promise<TreasuryTransaction> {
    return this.cashOutDirect(accountId, amount, null, null, reference, reason, actorUserId, manager, counter);
  }

  async reverseCustodyExpense(
    transactionId: string,
    reason: string,
    actorUserId: string,
    manager: EntityManager,
    counter: { configKey: string; reasonCode: string },
  ): Promise<TreasuryTransaction> {
    const legs = await this.reverseTransaction(transactionId, reason, actorUserId, manager, { ownerBypass: true, counter });
    return legs[0];
  }

  async cashOutForSupplier(
    accountId: string,
    amount: string,
    supplierId: string | null,
    supplierInvoiceId: string | null,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<TreasuryTransaction> {
    return this.cashOutCore(accountId, amount, null, null, reference, reason, actorUserId, NO_EMIT, manager, { supplierId, supplierInvoiceId });
  }

  /**
   * ADR-070 §9 — the payroll-side counterpart to `cashOutForSupplier`,
   * for `PayrollService.disburse()` to reach Treasury through this
   * contract instead of importing the concrete `TreasuryService`. Only
   * `.id` of the created transaction is ever read by callers. Non-emitting
   * (`NO_EMIT`) — the GL effect (Dr Wages Payable) was already posted by
   * `payroll.run.posted`'s own Financial Event; this leg is the cash
   * movement only, matching `cashOutForSupplier`'s identical shape.
   */
  async cashOutForEmployee(
    accountId: string,
    amount: string,
    employeeId: string | null,
    payrollRunId: string | null,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<{ id: string }> {
    return this.cashOutCore(accountId, amount, null, null, reference, reason, actorUserId, NO_EMIT, manager, undefined, { employeeId, payrollRunId });
  }

  /**
   * Transfer — `FinanceTreasuryContract` method; non-emitting.
   * F09-H3 (ADR-042 D3c) — see `cashIn`'s own doc comment for the additive `manager?` parameter.
   */
  async transfer(
    sourceAccountId: string,
    destinationAccountId: string,
    amount: string,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<{ out: TreasuryTransaction; in: TreasuryTransaction }> {
    return this.transferCore(sourceAccountId, destinationAccountId, amount, reference, reason, actorUserId, NO_EMIT, manager);
  }

  // --- Direct (Treasury-UI) variants — NOT part of any interface; these emit. ---

  /** Direct Treasury-UI Cash In. Publishes `treasury.cash.recorded` when the account is GL-mapped. */
  async cashInDirect(
    accountId: string,
    amount: string,
    customerId: string | null,
    salesOrderId: string | null,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    manager?: EntityManager,
    counter?: { configKey: string; reasonCode: string },
  ): Promise<TreasuryTransaction> {
    return this.cashInCore(accountId, amount, customerId, salesOrderId, reference, reason, actorUserId, { emitGlEvent: true, counter }, manager);
  }

  /** Direct Treasury-UI Cash Out. Publishes `treasury.cash.recorded` when the account is GL-mapped. */
  async cashOutDirect(
    accountId: string,
    amount: string,
    customerId: string | null,
    salesOrderId: string | null,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    manager?: EntityManager,
    counter?: { configKey: string; reasonCode: string },
  ): Promise<TreasuryTransaction> {
    return this.cashOutCore(accountId, amount, customerId, salesOrderId, reference, reason, actorUserId, { emitGlEvent: true, counter }, manager);
  }

  /** Direct Treasury-UI Transfer. Publishes `treasury.transfer.completed` when both accounts are GL-mapped. */
  async transferDirect(
    sourceAccountId: string,
    destinationAccountId: string,
    amount: string,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<{ out: TreasuryTransaction; in: TreasuryTransaction }> {
    return this.transferCore(sourceAccountId, destinationAccountId, amount, reference, reason, actorUserId, { emitGlEvent: true }, manager);
  }

  /**
   * Called only by DepositsService.approveDeposit, never a raw client
   * action — Finance approving a Deposit IS the control point; this
   * transaction needs no separate approval of its own. Runs before the
   * deposit itself is marked approved (validate-before-commit, same
   * ordering discipline as Warehouse's atomic posting fix), so an
   * inactive/missing treasury account fails the whole approval cleanly
   * with nothing changed yet.
   *
   * **Never publishes a `treasury.*` GL event** — the verified deposit's
   * GL mapping is `deposit.verified` (F09's to define — ADR-038 D4).
   */
  async createDepositTransaction(
    depositId: string,
    salesOrderId: string,
    customerId: string,
    amount: string,
    treasuryAccountId: string,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<TreasuryTransaction> {
    // Security Assurance Gate — Track S4, found 2026-09-08: defense in
    // depth alongside the fix in `DepositsService.submitDeposit` — this
    // is the actual point money moves (a `cash_in` leg + a Customer
    // Ledger credit are posted from here), and unlike `cashIn`/`cashOut`/
    // `transfer` above it never validated the amount itself, trusting
    // its only caller to have already done so. Never trust a single
    // caller to be the last line of defense for a financial-integrity
    // invariant this fundamental.
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      throw new BadRequestException('Deposit transaction amount must be a positive number.');
    }
    const account = await this.getAccount(treasuryAccountId, manager);
    this.assertActive(account);

    const txn = await (manager ?? this.dataSource).transaction(async (txManager) => {
      await txManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${treasuryAccountId}`]);
      return this.insertLeg(txManager, {
        type: 'cash_in',
        treasuryAccountId,
        amount,
        customerId,
        salesOrderId,
        depositId,
        transferGroupId: null,
        reference: null,
        reason: 'Customer deposit',
        movementDate: new Date(),
        createdByUserId: actorUserId,
        reversalOfTransactionId: null,
      });
    });

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'treasury.deposit_posted',
        resource: 'treasury_transaction',
        resourceId: txn.id,
        result: 'success',
        correlationId: null,
        after: { treasuryAccountId, amount, customerId, salesOrderId, depositId },
      },
      manager,
    );
    return txn;
  }

  /**
   * Reversal, never delete or edit (directive: no post-posting edits).
   * If the target is one leg of a Transfer, both legs are reversed
   * together so the ledger never goes double-entry-inconsistent.
   *
   * Controller-only (not in `FinanceTreasuryContract`) — so it emits the
   * GL event directly (ADR-038 D6): an **opposite-direction**
   * `treasury.cash.recorded` / `treasury.transfer.completed` carrying a
   * `reversalOf` reference and its own `idempotencyKey`. F03's two
   * built handlers produce the offsetting journal — no dedicated
   * `treasury.transaction.reversed` topic.
   */
  async reverseTransaction(
    transactionId: string,
    reason: string,
    actorUserId: string,
    manager?: EntityManager,
    /** `ownerBypass`: the caller IS the owning document (Treasury Document reverse) and takes responsibility for the business side; `counter`: the same posting-profile counter the original used. */
    options?: { ownerBypass?: boolean; counter?: { configKey: string; reasonCode: string } },
  ): Promise<TreasuryTransaction[]> {
    const repo = (manager ?? this.dataSource).getRepository(TreasuryTransaction);
    const original = await repo.findOne({ where: { id: transactionId } });
    if (!original) throw new NotFoundException(`Treasury transaction "${transactionId}" not found.`);
    if (original.status !== 'posted') {
      throw new ConflictException(`Cannot reverse a transaction in status "${original.status}".`);
    }
    // T2 (G-06b): a leg that belongs to a business document is reversed through THAT document, which also unwinds the subledger / invoice and publishes the
    // correct mirror event. A raw reversal here would offset the clearing account instead of AR/AP and leave the document, ledger and invoice untouched.
    const owner = options?.ownerBypass ? null : await this.findOwningDocument(original, manager);
    if (owner) {
      throw new ConflictException(`This movement belongs to ${owner} — reverse it through that document, not from the Treasury ledger. Nothing was changed.`);
    }

    const targets = original.transferGroupId
      ? await repo.find({ where: { transferGroupId: original.transferGroupId } })
      : [original];

    const OPPOSITE: Record<TreasuryTransactionType, TreasuryTransactionType> = {
      cash_in: 'cash_out',
      cash_out: 'cash_in',
      transfer_out: 'transfer_in',
      transfer_in: 'transfer_out',
    };
    const sortedAccountIds = [...new Set(targets.map((t) => t.treasuryAccountId))].sort();
    const reversalGroupId = original.transferGroupId ? randomUUID() : null;
    const affectedAccounts = new Map<string, TreasuryAccount>();
    for (const id of sortedAccountIds) affectedAccounts.set(id, await this.getAccount(id, manager));

    const reversals = await (manager ?? this.dataSource).transaction(async (txManager) => {
      for (const id of sortedAccountIds) {
        await txManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${id}`]);
      }

      // Security Assurance Gate — Track S5 (Concurrency/Race Condition),
      // found 2026-09-08: the account-level advisory lock above serializes
      // concurrent callers touching these accounts, but this method never
      // RE-CHECKED `status` after acquiring it — it used only the `status`
      // read before the lock even existed. Two concurrent
      // `reverseTransaction(sameId)` calls would both pass that early
      // check, then run one after another under the lock, EACH
      // unconditionally inserting its own reversal leg — a duplicate
      // reversal, double-crediting/debiting the account (the exact
      // "duplicate financial effect" class this Gate's Track S5 exists to
      // catch; same root shape as the `DepositsService.approveDeposit`
      // finding above, applied to Treasury's own reversal path). Fixed by
      // re-reading every target's CURRENT status under the lock and
      // aborting the WHOLE reversal (no partial reversal of a transfer
      // pair) if any of them already changed since the outer check.
      const freshTargets = await txManager.getRepository(TreasuryTransaction).find({ where: { id: In(targets.map((t) => t.id)) } });
      for (const fresh of freshTargets) {
        if (fresh.status !== 'posted') {
          throw new ConflictException(`Cannot reverse transaction "${fresh.id}" — its status changed to "${fresh.status}" (likely already reversed concurrently).`);
        }
      }

      const created: TreasuryTransaction[] = [];
      for (const target of targets) {
        const reversal = await this.insertLeg(txManager, {
          type: OPPOSITE[target.type],
          treasuryAccountId: target.treasuryAccountId,
          amount: target.amount,
          customerId: target.customerId,
          salesOrderId: target.salesOrderId,
          depositId: target.depositId,
          transferGroupId: reversalGroupId,
          reference: target.reference,
          reason: `Reversal: ${reason}`,
          movementDate: new Date(),
          createdByUserId: actorUserId,
          reversalOfTransactionId: target.id,
        });
        created.push(reversal);
        await txManager.getRepository(TreasuryTransaction).update(target.id, { status: 'reversed' });
      }

      // --- F06-H1: publish the offsetting GL event(s) (ADR-038 D6) ---
      if (original.transferGroupId && reversalGroupId) {
        // reverse a transfer: swap from/to, one event
        const originalOut = targets.find((t) => t.type === 'transfer_out');
        const originalIn = targets.find((t) => t.type === 'transfer_in');
        const reversalOutLeg = created.find((t) => t.transferGroupId === reversalGroupId && t.type === 'transfer_out'); // = original destination
        const reversalInLeg = created.find((t) => t.transferGroupId === reversalGroupId && t.type === 'transfer_in'); // = original source
        if (originalOut && originalIn && reversalOutLeg && reversalInLeg) {
          const originalSource = affectedAccounts.get(originalOut.treasuryAccountId)!;
          const originalDest = affectedAccounts.get(originalIn.treasuryAccountId)!;
          await this.emitTransferCompleted(
            txManager,
            {
              out: reversalOutLeg,
              in: reversalInLeg,
              source: originalDest, // swapped
              destination: originalSource, // swapped
              transferGroupId: reversalGroupId,
              reversalOf: original.transferGroupId,
            },
            EMIT_MIRROR,
          );
        }
      } else {
        // reverse a single cash movement: opposite-direction cash event
        const reversalLeg = created[0];
        const account = affectedAccounts.get(reversalLeg.treasuryAccountId)!;
        const direction: 'in' | 'out' = reversalLeg.type === 'cash_in' || reversalLeg.type === 'transfer_in' ? 'in' : 'out';
        await this.emitCashRecorded(
          txManager,
          { txn: reversalLeg, account, direction, reversalOf: original.id },
          options?.counter ? { ...EMIT_MIRROR, counter: options.counter } : EMIT_MIRROR,
        );
      }

      return created;
    });
    await this.events.dispatchAfterCommit(manager);

    for (const target of targets) {
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'treasury.transaction.reversed',
          resource: 'treasury_transaction',
          resourceId: target.id,
          result: 'success',
          correlationId: null,
          after: { reason },
        },
        manager,
      );
    }
    return reversals;
  }

  /**
   * T2 (G-06b) — which business document owns this Treasury leg's accounting story, or null when it is a plain Treasury movement (direct cash, transfer).
   * Owned legs: deposit, payroll disbursement, COD custody/settlement, customer payment, supplier payment. A reversal row inherits its original's owner.
   */
  private async findOwningDocument(leg: TreasuryTransaction, manager?: EntityManager): Promise<string | null> {
    const runner = manager ?? this.dataSource;
    if (leg.reversalOfTransactionId) {
      const original = await runner.getRepository(TreasuryTransaction).findOne({ where: { id: leg.reversalOfTransactionId } });
      if (original) return this.findOwningDocument(original, manager);
    }
    if (leg.depositId) return `customer deposit ${leg.depositId}`;
    if (leg.employeeId || leg.payrollRunId) return 'a payroll run';
    if (leg.reason === 'cod_collection_custody' || (leg.reason ?? '').startsWith('shipping_collection_')) return 'a delivery (COD) collection';
    const docPresent: Array<{ ok: boolean }> = await runner.query(`SELECT to_regclass('treasury_documents') IS NOT NULL AS ok`);
    if (docPresent[0]?.ok) {
      const docs: Array<{ n: string }> = await runner.query(
        `SELECT "documentNumber" AS n FROM "treasury_documents"
         WHERE "executedTransactionId" = $1 OR ($2::uuid IS NOT NULL AND "executedTransactionId" IN (SELECT id FROM treasury_transactions WHERE "transferGroupId" = $2)) LIMIT 1`,
        [leg.id, leg.transferGroupId],
      );
      if (docs.length > 0) return `treasury document ${docs[0].n}`;
    }
    for (const [table, label] of [
      ['customer_payments', 'customer payment'],
      ['supplier_payments', 'supplier payment'],
    ] as const) {
      const present: Array<{ ok: boolean }> = await runner.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table]);
      if (!present[0]?.ok) continue;
      const rows: Array<{ n: string }> = await runner.query(`SELECT "paymentNumber" AS n FROM "${table}" WHERE "treasuryTransactionId" = $1 LIMIT 1`, [leg.id]);
      if (rows.length > 0) return `${label} ${rows[0].n}`;
    }
    return null;
  }

  /**
   * T2 — the OWNER-driven reversal of a single cash leg: appends the offsetting leg, flips the original to `reversed`, audits — and publishes NOTHING
   * (the owning document publishes its own mirror event). Joins the caller's transaction. Refuses a transfer leg, an already-reversed leg, and (for a
   * receipt) a reversal the account cannot fund — money that is no longer there cannot be handed back.
   */
  async reverseOwnedLeg(transactionId: string, reason: string, actorUserId: string, manager: EntityManager): Promise<TreasuryTransaction> {
    return this.run(manager, async (m) => {
      const repo = m.getRepository(TreasuryTransaction);
      const original = await repo.findOne({ where: { id: transactionId } });
      if (!original) throw new NotFoundException(`Treasury transaction "${transactionId}" not found.`);
      if (original.transferGroupId) throw new BadRequestException('A transfer leg is not an owned cash leg — reverse the transfer itself.');
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${original.treasuryAccountId}`]);
      const fresh = await repo.findOne({ where: { id: transactionId } });
      if (!fresh || fresh.status !== 'posted') throw new ConflictException(`Cannot reverse transaction "${transactionId}" — it is "${fresh?.status ?? 'missing'}".`);
      if (fresh.type === 'cash_in') await this.assertSufficientBalance(m, fresh.treasuryAccountId, fresh.amount);
      const reversal = await this.insertLeg(m, {
        type: fresh.type === 'cash_in' ? 'cash_out' : 'cash_in',
        treasuryAccountId: fresh.treasuryAccountId,
        amount: fresh.amount,
        customerId: fresh.customerId,
        salesOrderId: fresh.salesOrderId,
        supplierId: fresh.supplierId,
        supplierInvoiceId: fresh.supplierInvoiceId,
        depositId: fresh.depositId,
        transferGroupId: null,
        reference: fresh.reference,
        reason: `Reversal: ${reason}`,
        movementDate: new Date(),
        createdByUserId: actorUserId,
        reversalOfTransactionId: fresh.id,
      });
      await repo.update(fresh.id, { status: 'reversed' });
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'treasury.transaction.reversed_by_owner', resource: 'treasury_transaction', resourceId: fresh.id, result: 'success', correlationId: reversal.id, after: { reason } },
        m,
      );
      return reversal;
    });
  }

  async listLedger(filters: { accountId?: string; customerId?: string; salesOrderId?: string }, manager?: EntityManager): Promise<TreasuryTransaction[]> {
    const repo = (manager ?? this.dataSource).getRepository(TreasuryTransaction);
    const where: Record<string, string> = {};
    if (filters.accountId) where.treasuryAccountId = filters.accountId;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.salesOrderId) where.salesOrderId = filters.salesOrderId;
    return repo.find({ where, order: { createdAt: 'DESC' } });
  }

  /**
   * Paginated sibling of `listLedger` above — same filters, `take`/`skip`
   * + a matching `count()` for `total`. Same `?page=&pageSize=` contract
   * as Customers/SalesOrders/WarehouseTransactions/Shipments
   * (`MASTER_PROJECT_STATUS.md` §6 pagination audit). `listLedger` itself
   * is left untouched — its only caller is this controller's own route,
   * grepped, so there's no full-set internal consumer to preserve.
   */
  async listLedgerPage(
    filters: { accountId?: string; customerId?: string; salesOrderId?: string },
    options: { page: number; pageSize: number },
    manager?: EntityManager,
  ): Promise<{ rows: TreasuryTransaction[]; total: number }> {
    const repo = (manager ?? this.dataSource).getRepository(TreasuryTransaction);
    const where: Record<string, string> = {};
    if (filters.accountId) where.treasuryAccountId = filters.accountId;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.salesOrderId) where.salesOrderId = filters.salesOrderId;
    const skip = (options.page - 1) * options.pageSize;
    const [rows, total] = await repo.findAndCount({ where, order: { createdAt: 'DESC' }, take: options.pageSize, skip });
    return { rows, total };
  }
}
