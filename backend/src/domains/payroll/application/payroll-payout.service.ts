import { HttpException, Inject, Injectable } from '@nestjs/common';
import { conflict, notFound } from './payroll-refusal';
import { DataSource, EntityManager, In } from 'typeorm';
import { FINANCE_TREASURY_CONTRACT, FinanceTreasuryContract } from '../../../foundation/module-registry/contracts/finance.contract';
import { PayrollRun } from '../infrastructure/payroll-run.entity';
import { PayrollRunLine } from '../infrastructure/payroll-run-line.entity';
import { PayrollPayoutBatch, PayoutBatchStatus } from '../infrastructure/payroll-payout-batch.entity';
import { PayrollPayoutItem } from '../infrastructure/payroll-payout-item.entity';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { runInTransaction } from '../../../foundation/transaction/run-in-transaction';
import { dec, money, sumMoney } from '../../../foundation/money/decimal-money';
import { PayrollSodService } from './payroll-sod.service';

export const PAYOUT_SETTLED_TOPIC = 'payroll.payout.settled';
const PAYOUT_DOC_TYPE = 'payroll_payout';

export interface ReconciliationDifference {
  code: string;
  message: string;
  expected: string;
  actual: string;
}

export interface PayrollReconciliation {
  run: { id: string; code: string; status: string; revision: number; kind: string };
  payroll: { totalNet: string; totalExpense: string; lineCount: number };
  ledger: { eventStatus: string | null; journalEntryId: string | null; expenseDebit: string; payableCredit: string };
  payouts: { paid: string; pending: string; failed: string; itemCount: number };
  payoutLedger: { postedEvents: number; payableDebit: string };
  treasury: { cashOut: string; transactionCount: number };
  outstanding: string;
  differences: ReconciliationDifference[];
  consistent: boolean;
}

/**
 * Addendum A-7 — disbursement as payout batches/items.
 *
 *  - Every payment is a `PayrollPayoutItem` with a unique idempotency key `payout:{runLineId}:{seq}`; the item row, the Treasury cash-out and the Financial Event
 *    `payroll.payout.settled` are written in ONE transaction per item, so a payment can never exist without its item and its ledger event, and a replay cannot
 *    create a second one (unique key + per-run advisory lock + remaining-balance check under the lock).
 *  - A failed payment (for example insufficient treasury balance) is recorded as a `failed` item with its reason and posts nothing; it stays as history and the
 *    outstanding amount is re-issued as a NEW item (`supersedesItemId`). Partial payment is the same mechanism (some items paid, some failed/outstanding).
 *  - The paying account must be GL-mapped (`requireGlMappedAccount`, the same gate supplier payments use); the mapped code travels in the event.
 *  - Nothing here is "complete" because cash moved: completion = item paid + Treasury transaction + Financial Event POSTED, which `reconcile` verifies.
 * Returns of already-paid money (bank rejects) need a Treasury cash-in contract that does not exist yet — not implemented, see the delivery matrix.
 */
@Injectable()
export class PayrollPayoutService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly numbering: NumberingService,
    private readonly sod: PayrollSodService,
    @Inject(FINANCE_TREASURY_CONTRACT) private readonly treasury: FinanceTreasuryContract,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async onModuleInit(): Promise<void> {
    await this.numbering.registerDocumentType(PAYOUT_DOC_TYPE, 'PYB', true).catch(() => undefined);
  }

  private async ensureNumbering(manager?: EntityManager): Promise<void> {
    if (!manager) return;
    await this.numbering.registerDocumentType(PAYOUT_DOC_TYPE, 'PYB', true, manager);
  }

  private async getRunOrThrow(runId: string, manager?: EntityManager): Promise<PayrollRun> {
    const run = await this.em(manager).getRepository(PayrollRun).findOne({ where: { id: runId } });
    if (!run) throw notFound('PAYROLL_RUN_NOT_FOUND', `PayrollRun "${runId}" not found.`);
    return run;
  }

  /** The Financial Event of the run must be POSTED before a single payment may be made (ADR-070 §9). */
  private async assertLedgerPosted(runId: string, manager?: EntityManager): Promise<void> {
    const [event]: Array<{ status: string }> = await this.em(manager).query(
      `SELECT status FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
      [runId],
    );
    if (!event || event.status.toUpperCase() !== 'POSTED') {
      throw conflict(
        'PAYROLL_PAYOUT_EVENT_NOT_POSTED',
        `PayrollRun "${runId}" cannot be disbursed — its Financial Event has not resolved POSTED (current: "${event?.status ?? 'none — not yet dispatched'}"). ADR-070 §9: disbursement never proceeds on PayrollRun.posted alone.`,
        { status: String(event?.status ?? 'none') },
      );
    }
  }

  /** Treasury's own refusal for an unmapped paying account, re-thrown with a stable code the screen can localize. */
  private async requireMapped(accountId: string, manager?: EntityManager) {
    try {
      return await this.treasury.requireGlMappedAccount(accountId, manager);
    } catch (e) {
      if (e instanceof HttpException && /not GL-mapped/i.test(e.message)) throw conflict('PAYROLL_PAYOUT_ACCOUNT_UNMAPPED', e.message);
      throw e;
    }
  }

  private async outstandingByLine(runId: string, manager: EntityManager, onlyLineIds?: string[]): Promise<Array<{ line: PayrollRunLine; remaining: string; lastItem: PayrollPayoutItem | null; nextSeq: number }>> {
    const lines = await manager.getRepository(PayrollRunLine).find({ where: { payrollRunId: runId } });
    const items = await manager.getRepository(PayrollPayoutItem).find({ where: { payrollRunId: runId } });
    const out: Array<{ line: PayrollRunLine; remaining: string; lastItem: PayrollPayoutItem | null; nextSeq: number }> = [];
    for (const line of lines) {
      if (onlyLineIds && !onlyLineIds.includes(line.id)) continue;
      if (!dec(line.netPay).gt(0)) continue;
      const mine = items.filter((i) => i.payrollRunLineId === line.id);
      const counted = sumMoney(mine.filter((i) => i.status === 'paid' || i.status === 'pending').map((i) => i.amount));
      const remaining = dec(line.netPay).minus(counted);
      if (remaining.lte(0)) continue;
      const failed = mine.filter((i) => i.status === 'failed').sort((a, b) => b.seq - a.seq);
      out.push({ line, remaining: money(remaining), lastItem: failed[0] ?? null, nextSeq: mine.reduce((m, i) => Math.max(m, i.seq), 0) + 1 });
    }
    return out;
  }

  async createBatch(
    runId: string,
    treasuryAccountId: string,
    actorUserId: string,
    manager?: EntityManager,
    opts: { method?: string | null; lineIds?: string[] } = {},
  ): Promise<{ batch: PayrollPayoutBatch; items: PayrollPayoutItem[] }> {
    const run = await this.getRunOrThrow(runId, manager);
    if (run.status !== 'posted') throw conflict('PAYROLL_PAYOUT_RUN_NOT_POSTED', `PayrollRun "${runId}" must be "posted" before disbursement (current: "${run.status}").`, { status: run.status });
    await this.assertLedgerPosted(runId, manager);
    await this.requireMapped(treasuryAccountId, manager); // before any write: an unmapped account produces zero side effects
    await this.ensureNumbering(manager);

    return runInTransaction(this.dataSource, manager, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payroll:payout:run:${runId}`]);
      const todo = await this.outstandingByLine(runId, tx, opts.lineIds);
      if (todo.length === 0) {
        throw conflict(run.disbursedAt ? 'PAYROLL_PAYOUT_ALREADY_DISBURSED' : 'PAYROLL_PAYOUT_NOTHING_OUTSTANDING', run.disbursedAt ? `PayrollRun "${runId}" has already been disbursed.` : `PayrollRun "${runId}" has nothing outstanding to pay (pending payouts already cover every line).`);
      }
      const code = await this.numbering.getNextNumber(PAYOUT_DOC_TYPE, tx);
      const batchRepo = tx.getRepository(PayrollPayoutBatch);
      const batch = await batchRepo.save(
        batchRepo.create({ code, payrollRunId: runId, treasuryAccountId, method: opts.method ?? null, status: 'draft', executions: 0, createdByUserId: actorUserId }),
      );
      const itemRepo = tx.getRepository(PayrollPayoutItem);
      const items: PayrollPayoutItem[] = [];
      for (const t of todo) {
        items.push(
          await itemRepo.save(
            itemRepo.create({
              payoutBatchId: batch.id,
              payrollRunId: runId,
              payrollRunLineId: t.line.id,
              employeeId: t.line.employeeId,
              amount: t.remaining,
              seq: t.nextSeq,
              idempotencyKey: `payout:${t.line.id}:${t.nextSeq}`,
              status: 'pending',
              supersedesItemId: t.lastItem?.id ?? null,
            }),
          ),
        );
      }
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'payroll.payout.batch_created', resource: 'payroll_payout_batch', resourceId: batch.id, result: 'success', correlationId: null, after: { runId, treasuryAccountId, itemCount: items.length, total: money(sumMoney(items.map((i) => i.amount))) } },
        tx,
      );
      return { batch, items };
    });
  }

  /** One payment, one transaction: item -> paid + Treasury cash-out + `payroll.payout.settled` event. A failure marks the item `failed` (outside the rolled-back transaction) and posts nothing. */
  private async settleItem(itemId: string, glAccountCode: string, treasuryAccountId: string, actorUserId: string, manager?: EntityManager): Promise<PayrollPayoutItem> {
    try {
      return await runInTransaction(this.dataSource, manager, async (tx) => {
        const item0 = await tx.getRepository(PayrollPayoutItem).findOne({ where: { id: itemId } });
        if (!item0) throw notFound('PAYROLL_PAYOUT_ITEM_NOT_FOUND', `Payout item "${itemId}" not found.`);
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payroll:payout:run:${item0.payrollRunId}`]);
        const repo = tx.getRepository(PayrollPayoutItem);
        const item = await repo.findOneOrFail({ where: { id: itemId } });
        if (item.status !== 'pending') return item; // already settled by an earlier attempt — idempotent
        const run = await tx.getRepository(PayrollRun).findOneOrFail({ where: { id: item.payrollRunId } });
        const txn = await this.treasury.cashOutForEmployee(treasuryAccountId, item.amount, item.employeeId, item.payrollRunId, `Payroll ${run.code}`, 'payroll_disbursement', actorUserId, tx);
        item.status = 'paid';
        item.treasuryTransactionId = txn.id;
        item.settledAt = new Date();
        item.failureReason = null;
        const saved = await repo.save(item);
        const batch = await tx.getRepository(PayrollPayoutBatch).findOneOrFail({ where: { id: item.payoutBatchId } });
        await this.events.publish(tx, PAYOUT_SETTLED_TOPIC, {
          idempotencyKey: `payroll:PayrollPayoutItem:${item.id}:settled`,
          businessDate: new Date().toISOString().slice(0, 10),
          orgUnitId: null,
          currency: 'EGP',
          sourceEntityType: 'PayrollPayoutItem',
          sourceEntityId: item.id,
          externalDocument: null,
          payloadVersion: 1,
          payoutItemId: item.id,
          payoutBatchId: batch.id,
          payoutBatchCode: batch.code,
          payrollRunId: item.payrollRunId,
          payrollRunCode: run.code,
          payrollRunLineId: item.payrollRunLineId,
          employeeId: item.employeeId,
          amount: item.amount,
          treasuryAccountId,
          treasuryTransactionId: txn.id,
          glAccountCode,
        });
        return saved;
      });
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      // The failed attempt rolled back (cash movement, event, item update). Record the failure as history, in its own small transaction.
      await runInTransaction(this.dataSource, manager, async (tx) => {
        const repo = tx.getRepository(PayrollPayoutItem);
        const item = await repo.findOne({ where: { id: itemId } });
        if (item && item.status === 'pending') {
          item.status = 'failed';
          item.failureReason = reason;
          item.settledAt = new Date();
          await repo.save(item);
          await this.audit.record(
            { actorUserId, organizationId: null, action: 'payroll.payout.item_failed', resource: 'payroll_payout_item', resourceId: itemId, result: 'failure', correlationId: null, after: { reason } },
            tx,
          );
        }
      });
      return this.em(manager).getRepository(PayrollPayoutItem).findOneOrFail({ where: { id: itemId } });
    }
  }

  async executeBatch(batchId: string, actorUserId: string, manager?: EntityManager): Promise<{ batch: PayrollPayoutBatch; items: PayrollPayoutItem[]; run: PayrollRun }> {
    const batch0 = await this.em(manager).getRepository(PayrollPayoutBatch).findOne({ where: { id: batchId } });
    if (!batch0) throw notFound('PAYROLL_PAYOUT_BATCH_NOT_FOUND', `Payout batch "${batchId}" not found.`);
    if (batch0.status === 'cancelled') throw conflict('PAYROLL_PAYOUT_BATCH_CANCELLED', `Payout batch "${batch0.code}" is cancelled.`, { code: batch0.code });
    const pending = await this.em(manager).getRepository(PayrollPayoutItem).find({ where: { payoutBatchId: batchId, status: 'pending' }, order: { seq: 'ASC', createdAt: 'ASC' } });
    if (pending.length === 0) throw conflict('PAYROLL_PAYOUT_BATCH_NO_PENDING', `Payout batch "${batch0.code}" has no pending items.`, { code: batch0.code });
    await this.sod.assert(batch0.payrollRunId, 'disburse', actorUserId, manager);
    const run0 = await this.getRunOrThrow(batch0.payrollRunId, manager);
    if (run0.status !== 'posted') throw conflict('PAYROLL_PAYOUT_RUN_NOT_POSTED', `PayrollRun "${run0.id}" must be "posted" before disbursement.`, { status: run0.status });
    await this.assertLedgerPosted(run0.id, manager);
    const { glAccountCode } = await this.requireMapped(batch0.treasuryAccountId, manager);

    for (const item of pending) {
      await this.settleItem(item.id, glAccountCode, batch0.treasuryAccountId, actorUserId, manager);
    }

    const result = await runInTransaction(this.dataSource, manager, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payroll:payout:run:${batch0.payrollRunId}`]);
      const items = await tx.getRepository(PayrollPayoutItem).find({ where: { payoutBatchId: batchId }, order: { seq: 'ASC' } });
      const paid = items.filter((i) => i.status === 'paid').length;
      const status: PayoutBatchStatus = items.some((i) => i.status === 'pending') ? 'executing' : paid === items.length ? 'completed' : paid > 0 ? 'partially_completed' : 'failed';
      const batchRepo = tx.getRepository(PayrollPayoutBatch);
      const batch = await batchRepo.findOneOrFail({ where: { id: batchId } });
      batch.status = status;
      batch.executions += 1;
      batch.executedByUserId = actorUserId;
      batch.executedAt = new Date();
      await batchRepo.save(batch);
      await this.sod.record(batch.payrollRunId, 'disburse', actorUserId, tx, batch.code);

      // run-level completion: every payable line fully paid
      const run = await tx.getRepository(PayrollRun).findOneOrFail({ where: { id: batch.payrollRunId } });
      const outstanding = await this.outstandingByLine(run.id, tx);
      const pendingAny = (await tx.getRepository(PayrollPayoutItem).count({ where: { payrollRunId: run.id, status: 'pending' } })) > 0;
      if (outstanding.length === 0 && !pendingAny && !run.disbursedAt) {
        run.disbursedAt = new Date();
        await tx.getRepository(PayrollRun).save(run);
      }
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'payroll.payout.batch_executed', resource: 'payroll_payout_batch', resourceId: batch.id, result: 'success', correlationId: null, after: { status, paid, total: items.length } },
        tx,
      );
      return { batch, items, run };
    });
    await this.events.dispatchAfterCommit(manager);
    return result;
  }

  /** Legacy single-action disbursement ("pay everything outstanding"): create the batch for every outstanding line and execute it. */
  async disburseAll(runId: string, treasuryAccountId: string, actorUserId: string, manager?: EntityManager): Promise<PayrollRun> {
    const { batch } = await this.createBatch(runId, treasuryAccountId, actorUserId, manager);
    const { run } = await this.executeBatch(batch.id, actorUserId, manager);
    return run;
  }

  async cancelBatch(batchId: string, actorUserId: string, manager?: EntityManager): Promise<PayrollPayoutBatch> {
    return runInTransaction(this.dataSource, manager, async (tx) => {
      const batch = await tx.getRepository(PayrollPayoutBatch).findOne({ where: { id: batchId } });
      if (!batch) throw notFound('PAYROLL_PAYOUT_BATCH_NOT_FOUND', `Payout batch "${batchId}" not found.`);
      if (batch.status !== 'draft') throw conflict('PAYROLL_PAYOUT_BATCH_NOT_DRAFT', `Only a draft batch can be cancelled (current: "${batch.status}").`, { status: batch.status });
      batch.status = 'cancelled';
      const saved = await tx.getRepository(PayrollPayoutBatch).save(batch);
      await tx.getRepository(PayrollPayoutItem).delete({ payoutBatchId: batchId, status: 'pending' });
      await this.audit.record({ actorUserId, organizationId: null, action: 'payroll.payout.batch_cancelled', resource: 'payroll_payout_batch', resourceId: batchId, result: 'success', correlationId: null }, tx);
      return saved;
    });
  }

  async listBatches(runId: string, manager?: EntityManager): Promise<Array<PayrollPayoutBatch & { items: PayrollPayoutItem[] }>> {
    const batches = await this.em(manager).getRepository(PayrollPayoutBatch).find({ where: { payrollRunId: runId }, order: { createdAt: 'ASC' } });
    if (batches.length === 0) return [];
    const items = await this.em(manager).getRepository(PayrollPayoutItem).find({ where: { payoutBatchId: In(batches.map((b) => b.id)) }, order: { seq: 'ASC', createdAt: 'ASC' } });
    return batches.map((b) => Object.assign(b, { items: items.filter((i) => i.payoutBatchId === b.id) }));
  }

  /** Lines = journal = payouts = Treasury, per run. Read-only. A difference is reported, never repaired here. */
  async reconcile(runId: string, manager?: EntityManager): Promise<PayrollReconciliation> {
    const m = this.em(manager);
    const run = await this.getRunOrThrow(runId, manager);
    const lines = await m.getRepository(PayrollRunLine).find({ where: { payrollRunId: runId } });
    const totalNet = sumMoney(lines.map((l) => l.netPay));
    const totalExpense = sumMoney(lines.map((l) => dec(l.grossPay).plus(dec(l.commissionAmount)).plus(dec(l.adjustmentsAmount))));

    const [event]: Array<{ status: string; journalEntryId: string | null }> = await m.query(
      `SELECT status, "journalEntryId" FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
      [runId],
    );
    let expenseDebit = dec(0);
    let payableCredit = dec(0);
    if (event?.journalEntryId && event.status.toUpperCase() === 'POSTED') {
      const rows: Array<{ debit: string; credit: string; controlFunction: string | null }> = await m.query(
        `SELECT jl."debitBase" AS debit, jl."creditBase" AS credit, a."controlFunction" AS "controlFunction"
           FROM accounting_journal_lines jl JOIN accounting_gl_accounts a ON a.id = jl."accountId" WHERE jl."journalEntryId" = $1`,
        [event.journalEntryId],
      );
      for (const r of rows) {
        if (r.controlFunction === 'wages_payable') payableCredit = payableCredit.plus(dec(r.credit)).minus(dec(r.debit));
        else expenseDebit = expenseDebit.plus(dec(r.debit)).minus(dec(r.credit));
      }
    }

    const items = await m.getRepository(PayrollPayoutItem).find({ where: { payrollRunId: runId } });
    const paid = sumMoney(items.filter((i) => i.status === 'paid').map((i) => i.amount));
    const pend = sumMoney(items.filter((i) => i.status === 'pending').map((i) => i.amount));
    const failed = sumMoney(items.filter((i) => i.status === 'failed').map((i) => i.amount));

    let postedEvents = 0;
    let payableDebit = dec(0);
    const paidIds = items.filter((i) => i.status === 'paid').map((i) => i.id);
    if (paidIds.length > 0) {
      const evs: Array<{ journalEntryId: string | null; status: string }> = await m.query(
        `SELECT "journalEntryId", status FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollPayoutItem' AND "sourceEntityId"::text = ANY($1::text[])`,
        [paidIds],
      );
      for (const e of evs) {
        if (e.status.toUpperCase() !== 'POSTED' || !e.journalEntryId) continue;
        postedEvents += 1;
        const rows: Array<{ debit: string; credit: string }> = await m.query(
          `SELECT jl."debitBase" AS debit, jl."creditBase" AS credit FROM accounting_journal_lines jl JOIN accounting_gl_accounts a ON a.id = jl."accountId"
            WHERE jl."journalEntryId" = $1 AND a."controlFunction" = 'wages_payable'`,
          [e.journalEntryId],
        );
        for (const r of rows) payableDebit = payableDebit.plus(dec(r.debit)).minus(dec(r.credit));
      }
    }

    const [tr]: Array<{ total: string | null; n: number }> = await m.query(
      `SELECT COALESCE(SUM(amount), 0)::text AS total, COUNT(*)::int AS n FROM treasury_transactions WHERE "payrollRunId" = $1 AND type = 'cash_out'`,
      [runId],
    );

    const differences: ReconciliationDifference[] = [];
    const check = (code: string, message: string, expected: ReturnType<typeof dec>, actual: ReturnType<typeof dec>) => {
      if (!expected.eq(actual)) differences.push({ code, message, expected: money(expected), actual: money(actual) });
    };
    if (run.status === 'posted') {
      if (!event || event.status.toUpperCase() !== 'POSTED') differences.push({ code: 'LEDGER_NOT_POSTED', message: 'The accrual Financial Event is not POSTED.', expected: 'POSTED', actual: event?.status ?? 'none' });
      else {
        check('LEDGER_PAYABLE_NE_NET', 'Wages Payable credited by the accrual differs from the run net pay.', totalNet, payableCredit);
        check('LEDGER_EXPENSE_NE_PAYROLL', 'Expense debited by the accrual differs from gross + commission + adjustments of the lines.', totalExpense, expenseDebit);
      }
    }
    check('PAID_NE_TREASURY', 'Paid payout items differ from the Treasury cash-out transactions of the run.', paid, dec(tr?.total ?? 0));
    check('PAID_NE_PAYOUT_LEDGER', 'Paid payout items differ from the Wages Payable debited by their POSTED events.', paid, payableDebit);
    if (paid.gt(totalNet)) differences.push({ code: 'OVERPAID', message: 'More has been paid than the run net pay.', expected: money(totalNet), actual: money(paid) });

    return {
      run: { id: run.id, code: run.code, status: run.status, revision: run.revision, kind: run.kind },
      payroll: { totalNet: money(totalNet), totalExpense: money(totalExpense), lineCount: lines.length },
      ledger: { eventStatus: event?.status ?? null, journalEntryId: event?.journalEntryId ?? null, expenseDebit: money(expenseDebit), payableCredit: money(payableCredit) },
      payouts: { paid: money(paid), pending: money(pend), failed: money(failed), itemCount: items.length },
      payoutLedger: { postedEvents, payableDebit: money(payableDebit) },
      treasury: { cashOut: money(tr?.total ?? 0), transactionCount: tr?.n ?? 0 },
      outstanding: money(totalNet.minus(paid)),
      differences,
      consistent: differences.length === 0,
    };
  }
}
