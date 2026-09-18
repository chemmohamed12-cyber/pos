import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { TreasuryAccount } from '../infrastructure/treasury-account.entity';
import { TreasuryAccountType } from '../infrastructure/treasury-account-type.entity';
import { TreasuryTransaction, TreasuryTransactionType } from '../infrastructure/treasury-transaction.entity';
import { canTransitionTreasuryAccountStatus, TreasuryAccountStatus } from '../domain/treasury-account-status';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';

const NUMBERING_SERIES: Record<TreasuryTransactionType, string> = {
  cash_in: 'treasury_cash_in',
  cash_out: 'treasury_cash_out',
  transfer_out: 'treasury_transfer',
  transfer_in: 'treasury_transfer',
};

/**
 * Financial/Treasury Core — a real ledger-backed foundation (accounts +
 * append-only transactions), not a "safe" bolted onto Sales Orders. This
 * is the one place account balances are computed; nothing else in the
 * codebase writes a balance field, because there isn't one — every
 * balance is `SUM` over this domain's own ledger, the same discipline
 * Warehouse already uses for stock (`on hand` from `stock_movements`).
 */
@Injectable()
export class TreasuryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  async createAccountType(code: string, name: string, actorUserId: string): Promise<TreasuryAccountType> {
    const repo = this.dataSource.getRepository(TreasuryAccountType);
    const existing = await repo.findOne({ where: { code } });
    if (existing) throw new ConflictException(`Treasury account type code "${code}" is already in use.`);

    const saved = await repo.save(repo.create({ code, name }));
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'treasury.account_type.created',
      resource: 'treasury_account_type',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { code, name },
    });
    return saved;
  }

  async listAccountTypes(): Promise<TreasuryAccountType[]> {
    return this.dataSource.getRepository(TreasuryAccountType).find({ order: { code: 'ASC' } });
  }

  async getAccountType(accountTypeId: string): Promise<TreasuryAccountType> {
    const type = await this.dataSource.getRepository(TreasuryAccountType).findOne({ where: { id: accountTypeId } });
    if (!type) throw new NotFoundException(`Treasury account type "${accountTypeId}" not found.`);
    return type;
  }

  async createAccount(code: string, name: string, accountTypeId: string, actorUserId: string): Promise<TreasuryAccount> {
    const repo = this.dataSource.getRepository(TreasuryAccount);
    const existing = await repo.findOne({ where: { code } });
    if (existing) throw new ConflictException(`Treasury account code "${code}" is already in use.`);
    await this.getAccountType(accountTypeId); // 404s if the type doesn't exist — never silently accept an orphan type id

    const saved = await repo.save(repo.create({ code, name, accountTypeId }));
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'treasury.account.created',
      resource: 'treasury_account',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { code, name, accountTypeId },
    });
    return saved;
  }

  async getAccount(accountId: string): Promise<TreasuryAccount> {
    const account = await this.dataSource.getRepository(TreasuryAccount).findOne({ where: { id: accountId } });
    if (!account) throw new NotFoundException(`Treasury account "${accountId}" not found.`);
    return account;
  }

  async setAccountStatus(accountId: string, status: TreasuryAccountStatus, actorUserId: string): Promise<TreasuryAccount> {
    const repo = this.dataSource.getRepository(TreasuryAccount);
    const account = await this.getAccount(accountId);
    if (!canTransitionTreasuryAccountStatus(account.status, status)) {
      throw new ConflictException(`Cannot transition treasury account "${accountId}" from "${account.status}" to "${status}".`);
    }
    account.status = status;
    const saved = await repo.save(account);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: `treasury.account.${status === 'active' ? 'activated' : 'deactivated'}`,
      resource: 'treasury_account',
      resourceId: accountId,
      result: 'success',
      correlationId: null,
      after: { status },
    });
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

  async listAccountsWithBalances(): Promise<Array<TreasuryAccount & { balance: string; accountTypeCode: string; accountTypeName: string }>> {
    const accounts = await this.dataSource.getRepository(TreasuryAccount).find({ order: { code: 'ASC' } });
    const types = await this.listAccountTypes();
    const typeById = new Map(types.map((t) => [t.id, t]));
    return Promise.all(
      accounts.map(async (a) => ({
        ...a,
        balance: await this.getAccountBalance(a.id),
        accountTypeCode: typeById.get(a.accountTypeId)?.code ?? '',
        accountTypeName: typeById.get(a.accountTypeId)?.name ?? '',
      })),
    );
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
      depositId: string | null;
      transferGroupId: string | null;
      reference: string | null;
      reason: string | null;
      movementDate: Date;
      createdByUserId: string;
      reversalOfTransactionId: string | null;
    },
  ): Promise<TreasuryTransaction> {
    const transactionNumber = await this.numbering.getNextNumber(NUMBERING_SERIES[input.type]);
    const repo = manager.getRepository(TreasuryTransaction);
    return repo.save(repo.create({ ...input, transactionNumber }));
  }

  /**
   * Manual Cash In — finance/admin only, not order-linked (customerId/
   * salesOrderId are optional context, e.g. a general capital injection).
   */
  async cashIn(
    accountId: string,
    amount: string,
    customerId: string | null,
    salesOrderId: string | null,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
  ): Promise<TreasuryTransaction> {
    if (Number(amount) <= 0) throw new BadRequestException('Amount must be positive.');
    const account = await this.getAccount(accountId);
    this.assertActive(account);

    const txn = await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${accountId}`]);
      return this.insertLeg(manager, {
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
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'treasury.cash_in',
      resource: 'treasury_transaction',
      resourceId: txn.id,
      result: 'success',
      correlationId: null,
      after: { accountId, amount, customerId, salesOrderId },
    });
    return txn;
  }

  /** Manual Cash Out — finance/admin only, server-enforced against the account's real ledger balance (never trust a client-supplied balance). */
  async cashOut(
    accountId: string,
    amount: string,
    customerId: string | null,
    salesOrderId: string | null,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
  ): Promise<TreasuryTransaction> {
    if (Number(amount) <= 0) throw new BadRequestException('Amount must be positive.');
    const account = await this.getAccount(accountId);
    this.assertActive(account);

    const txn = await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${accountId}`]);
      await this.assertSufficientBalance(manager, accountId, amount);
      return this.insertLeg(manager, {
        type: 'cash_out',
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
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'treasury.cash_out',
      resource: 'treasury_transaction',
      resourceId: txn.id,
      result: 'success',
      correlationId: null,
      after: { accountId, amount, customerId, salesOrderId },
    });
    return txn;
  }

  /** Transfer — two ledger legs (out of source, in to destination) under one shared `transferGroupId`, both posted atomically or neither. */
  async transfer(
    sourceAccountId: string,
    destinationAccountId: string,
    amount: string,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
  ): Promise<{ out: TreasuryTransaction; in: TreasuryTransaction }> {
    if (Number(amount) <= 0) throw new BadRequestException('Amount must be positive.');
    if (sourceAccountId === destinationAccountId) throw new BadRequestException('Source and destination accounts must differ.');
    const [source, destination] = await Promise.all([this.getAccount(sourceAccountId), this.getAccount(destinationAccountId)]);
    this.assertActive(source);
    this.assertActive(destination);

    const transferGroupId = randomUUID();
    const movementDate = new Date();
    // Sorted lock ordering (deadlock safety) — same pattern as Warehouse's multi-pair advisory locks.
    const sortedIds = [sourceAccountId, destinationAccountId].sort();

    const { out, in: inLeg } = await this.dataSource.transaction(async (manager) => {
      for (const id of sortedIds) {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${id}`]);
      }
      await this.assertSufficientBalance(manager, sourceAccountId, amount);

      const outLeg = await this.insertLeg(manager, {
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
      const inLeg = await this.insertLeg(manager, {
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
      return { out: outLeg, in: inLeg };
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'treasury.transfer',
      resource: 'treasury_transaction',
      resourceId: out.id,
      result: 'success',
      correlationId: null,
      after: { sourceAccountId, destinationAccountId, amount, transferGroupId },
    });
    return { out, in: inLeg };
  }

  /**
   * Called only by DepositsService.approveDeposit, never a raw client
   * action — Finance approving a Deposit IS the control point; this
   * transaction needs no separate approval of its own. Runs before the
   * deposit itself is marked approved (validate-before-commit, same
   * ordering discipline as Warehouse's atomic posting fix), so an
   * inactive/missing treasury account fails the whole approval cleanly
   * with nothing changed yet.
   */
  async createDepositTransaction(
    depositId: string,
    salesOrderId: string,
    customerId: string,
    amount: string,
    treasuryAccountId: string,
    actorUserId: string,
  ): Promise<TreasuryTransaction> {
    const account = await this.getAccount(treasuryAccountId);
    this.assertActive(account);

    const txn = await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${treasuryAccountId}`]);
      return this.insertLeg(manager, {
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

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'treasury.deposit_posted',
      resource: 'treasury_transaction',
      resourceId: txn.id,
      result: 'success',
      correlationId: null,
      after: { treasuryAccountId, amount, customerId, salesOrderId, depositId },
    });
    return txn;
  }

  /**
   * Reversal, never delete or edit (directive: no post-posting edits).
   * If the target is one leg of a Transfer, both legs are reversed
   * together so the ledger never goes double-entry-inconsistent.
   */
  async reverseTransaction(transactionId: string, reason: string, actorUserId: string): Promise<TreasuryTransaction[]> {
    const repo = this.dataSource.getRepository(TreasuryTransaction);
    const original = await repo.findOne({ where: { id: transactionId } });
    if (!original) throw new NotFoundException(`Treasury transaction "${transactionId}" not found.`);
    if (original.status !== 'posted') {
      throw new ConflictException(`Cannot reverse a transaction in status "${original.status}".`);
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

    const reversals = await this.dataSource.transaction(async (manager) => {
      for (const id of sortedAccountIds) {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${id}`]);
      }
      const created: TreasuryTransaction[] = [];
      for (const target of targets) {
        const reversal = await this.insertLeg(manager, {
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
        await manager.getRepository(TreasuryTransaction).update(target.id, { status: 'reversed' });
      }
      return created;
    });

    for (const target of targets) {
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'treasury.transaction.reversed',
        resource: 'treasury_transaction',
        resourceId: target.id,
        result: 'success',
        correlationId: null,
        after: { reason },
      });
    }
    return reversals;
  }

  async listLedger(filters: { accountId?: string; customerId?: string; salesOrderId?: string }): Promise<TreasuryTransaction[]> {
    const repo = this.dataSource.getRepository(TreasuryTransaction);
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
  ): Promise<{ rows: TreasuryTransaction[]; total: number }> {
    const repo = this.dataSource.getRepository(TreasuryTransaction);
    const where: Record<string, string> = {};
    if (filters.accountId) where.treasuryAccountId = filters.accountId;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.salesOrderId) where.salesOrderId = filters.salesOrderId;
    const skip = (options.page - 1) * options.pageSize;
    const [rows, total] = await repo.findAndCount({ where, order: { createdAt: 'DESC' }, take: options.pageSize, skip });
    return { rows, total };
  }
}
