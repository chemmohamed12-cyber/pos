import { ConflictException, ForbiddenException } from '@nestjs/common';
import { buildPayrollFixture, PayrollFixture } from '../../../foundation/testing/payroll-company-fixture';

/**
 * Payroll -> Accounting -> Treasury, financial end to end (CTO mandate 2026-10-25; ADR-070 Addendum A-7/A-8) — real Postgres, the REAL Financial Event pipeline
 * (handlers, journal posting gate, fiscal-period gate), the REAL Treasury service, a real chart (5201 / 2150 / 1102). Every assertion is on ledger / treasury rows.
 *
 *  R-ACC-01 accrual basis   R-ACC-02 payout batches/items + ledger event   R-ACC-03 partial / failed / re-issue   R-ACC-04 reconciliation (lines = journal = payouts = treasury)
 *  R-ACC-05 idempotency under concurrency   R-ACC-06 closed fiscal period: rejected event, refused disbursement, documented redrive   SoD on disbursement
 */
describe('Payroll financial integrity — accrual, payouts, reconciliation (real PG, real ledger and treasury)', () => {
  jest.setTimeout(580_000);
  let f: PayrollFixture;
  const u = () => f.users.A;

  const journalOf = async (sourceType: string, sourceId: string) => {
    const ds = await f.dsOf('A');
    const ev: Array<{ status: string; journalEntryId: string | null }> = await ds.query(`SELECT status, "journalEntryId" FROM accounting_financial_events WHERE "sourceEntityType" = $1 AND "sourceEntityId"::text = $2`, [sourceType, sourceId]);
    if (ev.length === 0) return null;
    const lines: Array<{ code: string; dr: string; cr: string }> = ev[0].journalEntryId
      ? await ds.query(`SELECT a.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM accounting_journal_lines jl JOIN accounting_gl_accounts a ON a.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY a.code`, [ev[0].journalEntryId])
      : [];
    return { status: ev[0].status.toUpperCase(), lines: lines.map((l) => (Number(l.dr) > 0 ? `${l.code} D ${Number(l.dr).toFixed(2)}` : `${l.code} C ${Number(l.cr).toFixed(2)}`)) };
  };
  const cashOut = async (runId: string) => Number((await (await f.mgr('A')).query(`SELECT COALESCE(SUM(amount),0)::text AS t FROM treasury_transactions WHERE "payrollRunId" = $1 AND type = 'cash_out'`, [runId]))[0].t);
  const smallAccount = async (code: string, amount: string): Promise<string> => {
    const m = await f.mgr('A');
    const bank = (await f.treasury.listAccountTypes(m)).find((t) => t.code === 'bank')!;
    const a = await f.treasury.createAccount(code, code, bank.id, u().pay, m);
    await f.treasury.setAccountGlMapping(a.id, '1102', u().pay, m);
    await f.fund('A', a.id, amount);
    return a.id;
  };

  beforeAll(async () => {
    f = await buildPayrollFixture('payroll_fin');
    await f.employee('A', 'Fin One', '1000.00');
    await f.employee('A', 'Fin Two', '800.00');
  });

  afterAll(async () => {
    await f.teardown();
  });

  it('R-ACC-01 — the accrual posts Dr 5201 / Cr 2150 for exactly the run (gross + commission + adjustments / net); the reconciliation of an un-paid run is consistent with the whole net outstanding', async () => {
    const mA = await f.mgr('A');
    const p = await f.period('A', '2026-03', '2026-03-01', '2026-03-31');
    const run = await f.postRun('A', p);
    expect(run.status).toBe('posted');
    expect(await journalOf('PayrollRun', run.id)).toEqual({ status: 'POSTED', lines: ['2150 C 1800.00', '5201 D 1800.00'] });
    const rec = await f.payroll.reconcile(run.id, mA);
    expect(rec).toMatchObject({ consistent: true, outstanding: '1800.00', payroll: { totalNet: '1800.00', totalExpense: '1800.00' }, ledger: { expenseDebit: '1800.00', payableCredit: '1800.00' }, payouts: { paid: '0.00' } });
    // a replay of the posting event is a no-op (idempotency key unique per run)
    const feId = (await mA.query(`SELECT id FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`, [run.id]))[0].id;
    expect((await f.financialEvents.redrive(feId, mA)).deduped).toBe(true);
    expect((await mA.query(`SELECT count(*)::int AS n FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`, [run.id]))[0].n).toBe(1);
  });

  it('R-ACC-02/03/04 — partial payment: a failing payment posts nothing and stays as history; the paid part reduces Wages Payable exactly; re-issue pays the rest; lines = journal = payouts = treasury at every step', async () => {
    const mA = await f.mgr('A');
    const run = (await f.payroll.listRuns(mA)).find((r) => r.status === 'posted')!;
    const account = await smallAccount('FINSMALL', '1000.00'); // enough for ONE of the two employees
    const ledgerBefore = await f.ledger('A');

    const { batch, items } = await f.payouts.createBatch(run.id, account, u().pay, mA);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.idempotencyKey).sort()).toEqual(items.map((i) => `payout:${i.payrollRunLineId}:1`).sort());
    const executed = await f.payouts.executeBatch(batch.id, u().pay, mA);
    await f.drain('A');
    const paid = executed.items.filter((i) => i.status === 'paid');
    const failed = executed.items.filter((i) => i.status === 'failed');
    expect(paid).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].failureReason).toMatch(/Insufficient treasury balance/i);
    expect(failed[0].treasuryTransactionId).toBeNull();
    expect(executed.batch.status).toBe('partially_completed');
    expect(executed.run.disbursedAt).toBeNull();

    const paidAmount = Number(paid[0].amount);
    expect(await cashOut(run.id)).toBe(paidAmount); // only the successful payment moved cash
    expect(await journalOf('PayrollPayoutItem', paid[0].id)).toEqual({ status: 'POSTED', lines: [`1102 C ${paidAmount.toFixed(2)}`, `2150 D ${paidAmount.toFixed(2)}`] });
    expect(await journalOf('PayrollPayoutItem', failed[0].id)).toBeNull(); // the failed payment left no ledger trace
    const mid = await f.payroll.reconcile(run.id, mA);
    expect(mid.consistent).toBe(true);
    expect(mid).toMatchObject({ payouts: { failed: failed[0].amount }, outstanding: (1800 - paidAmount).toFixed(2) });
    const ledgerMid = await f.ledger('A');
    expect(Number(ledgerMid.payable) - Number(ledgerBefore.payable)).toBeCloseTo(paidAmount, 2); // Wages Payable (a credit balance) went down by exactly what was paid
    expect(ledgerMid.expense).toBe(ledgerBefore.expense); // paying never touches the expense

    // re-issue: the shortfall is paid by a NEW item that points at the failed one
    await f.fund('A', account, '2000.00');
    const run2 = await f.payouts.disburseAll(run.id, account, u().pay, mA);
    await f.drain('A');
    expect(run2.disbursedAt).not.toBeNull();
    const all = await f.payouts.listBatches(run.id, mA);
    const reissued = all.flatMap((b) => b.items).find((i) => i.supersedesItemId === failed[0].id)!;
    expect(reissued).toMatchObject({ status: 'paid', seq: 2, payrollRunLineId: failed[0].payrollRunLineId });
    const done = await f.payroll.reconcile(run.id, mA);
    expect(done).toMatchObject({ consistent: true, outstanding: '0.00', payouts: { paid: '1800.00' }, treasury: { cashOut: '1800.00' }, payoutLedger: { payableDebit: '1800.00' } });
    expect(Number((await f.ledger('A')).payable)).toBe(0); // the liability for this run is fully discharged (sum of all runs so far = this one)
    // nothing left to pay: the legacy single action reports it plainly
    await expect(f.payroll.disburse(run.id, account, u().pay, mA)).rejects.toThrow(/already been disbursed/);
  });

  it('SoD — the person who approved the run cannot disburse it; an unmapped paying account is refused before any write; a draft batch can be cancelled', async () => {
    const mA = await f.mgr('A');
    const p = await f.period('A', '2026-04', '2026-04-01', '2026-04-30');
    const run = await f.postRun('A', p); // approved by `appr`
    const before = await cashOut(run.id);
    // unmapped account -> refused with ZERO side effects
    const batchesBefore = (await mA.query(`SELECT count(*)::int AS n FROM payroll_payout_batches`))[0].n;
    await expect(f.payouts.createBatch(run.id, f.treasuryAccounts.A.unmapped, u().pay, mA)).rejects.toBeInstanceOf(ConflictException);
    expect((await mA.query(`SELECT count(*)::int AS n FROM payroll_payout_batches`))[0].n).toBe(batchesBefore);

    const { batch } = await f.payouts.createBatch(run.id, f.treasuryAccounts.A.mapped, u().pay, mA);
    const e = await f.payouts.executeBatch(batch.id, u().appr, mA).catch((x) => x);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'SOD_VIOLATION', conflictsWith: 'approve' });
    expect(await cashOut(run.id)).toBe(before); // nothing moved
    const cancelled = await f.payouts.cancelBatch(batch.id, u().pay, mA);
    expect(cancelled.status).toBe('cancelled');
    expect((await mA.query(`SELECT count(*)::int AS n FROM payroll_payout_items WHERE "payoutBatchId" = $1`, [batch.id]))[0].n).toBe(0);
  });

  it('R-ACC-05 — two executions of the same batch at the same time pay each employee exactly once: one cash movement and one ledger event per item', async () => {
    const mA = await f.mgr('A');
    const p = await f.period('A', '2026-05', '2026-05-01', '2026-05-31');
    const run = await f.postRun('A', p);
    const { batch, items } = await f.payouts.createBatch(run.id, f.treasuryAccounts.A.mapped, u().pay, mA);
    const results = await Promise.allSettled([f.payouts.executeBatch(batch.id, u().pay, mA), f.payouts.executeBatch(batch.id, u().extra, mA)]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    await f.drain('A');
    const rows = await mA.query(`SELECT status FROM payroll_payout_items WHERE "payoutBatchId" = $1`, [batch.id]);
    expect(rows.map((r: { status: string }) => r.status)).toEqual(items.map(() => 'paid'));
    expect(await cashOut(run.id)).toBe(1800); // not 3600
    expect((await mA.query(`SELECT count(*)::int AS n FROM treasury_transactions WHERE "payrollRunId" = $1`, [run.id]))[0].n).toBe(items.length);
    expect((await mA.query(`SELECT count(*)::int AS n FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollPayoutItem' AND "sourceEntityId"::text = ANY($1::text[])`, [items.map((i) => i.id)]))[0].n).toBe(items.length);
    expect(await f.payroll.reconcile(run.id, mA)).toMatchObject({ consistent: true, outstanding: '0.00' });
    // a replay is refused plainly, not re-executed
    await expect(f.payouts.executeBatch(batch.id, u().pay, mA)).rejects.toThrow(/no pending items/i);
  });

  it('R-ACC-06 — closed fiscal period: the run reaches "posted" but its Financial Event is REJECTED, the gap detector flags it and disbursement is refused; reopening and re-driving posts it ONCE', async () => {
    const mA = await f.mgr('A');
    const dsA = await f.dsOf('A');
    await dsA.query(`UPDATE process_instances SET "currentState" = 'closed' WHERE "entityType" = 'FiscalPeriod'`);
    const p = await f.period('A', '2026-06', '2026-06-01', '2026-06-30');
    const run = await f.postRun('A', p);
    expect(run.status).toBe('posted');
    const fe = await f.payroll.getFinancialEventStatus(run.id, mA);
    expect(fe?.status.toUpperCase()).toBe('REJECTED');
    expect(fe?.rejectionReason).toMatch(/closed|not open/i);
    expect((await f.payroll.listReconciliationGaps(mA)).map((g) => g.payrollRunId)).toContain(run.id);
    await expect(f.payouts.createBatch(run.id, f.treasuryAccounts.A.mapped, u().pay, mA)).rejects.toThrow(/has not resolved POSTED/);
    expect(await cashOut(run.id)).toBe(0);
    expect((await f.payroll.reconcile(run.id, mA)).differences.map((d) => d.code)).toContain('LEDGER_NOT_POSTED');

    // recovery: the period is reopened by the accounting owner, the rejected event is re-driven
    await dsA.query(`UPDATE process_instances SET "currentState" = 'open' WHERE "entityType" = 'FiscalPeriod'`);
    const eventId = (await mA.query(`SELECT id FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`, [run.id]))[0].id;
    const redriven = await f.financialEvents.redrive(eventId, mA);
    expect(redriven.status).toBe('POSTED');
    expect((await f.financialEvents.redrive(eventId, mA)).deduped).toBe(true); // a second re-drive creates no second entry
    expect((await mA.query(`SELECT count(*)::int AS n FROM accounting_journal_entries WHERE id = $1`, [redriven.journalEntryId]))[0].n).toBe(1);
    expect((await f.payroll.listReconciliationGaps(mA)).map((g) => g.payrollRunId)).not.toContain(run.id);
    const { batch } = await f.payouts.createBatch(run.id, f.treasuryAccounts.A.mapped, u().pay, mA);
    await f.payouts.executeBatch(batch.id, u().pay, mA);
    await f.drain('A');
    expect(await f.payroll.reconcile(run.id, mA)).toMatchObject({ consistent: true, outstanding: '0.00' });
  });

  it('R-ACC-04 — the reconciliation reports a discrepancy instead of hiding it (an item marked paid behind the services: no cash movement, no ledger event)', async () => {
    const mA = await f.mgr('A');
    const p = await f.period('A', '2026-07', '2026-07-01', '2026-07-31');
    const run = await f.postRun('A', p);
    const { items } = await f.payouts.createBatch(run.id, f.treasuryAccounts.A.mapped, u().pay, mA);
    await mA.query(`UPDATE payroll_payout_items SET status = 'paid', "settledAt" = now() WHERE id = $1`, [items[0].id]);
    const rec = await f.payroll.reconcile(run.id, mA);
    expect(rec.consistent).toBe(false);
    expect(rec.differences.map((d) => d.code)).toEqual(expect.arrayContaining(['PAID_NE_TREASURY', 'PAID_NE_PAYOUT_LEDGER']));
  });

  it('R-SEC-01 — payout, batch and ledger rows of Company A never appear in Company B', async () => {
    const mA = await f.mgr('A');
    const mB = await f.mgr('B');
    const ids = (await mA.query(`SELECT id FROM payroll_payout_items`)).map((r: { id: string }) => r.id);
    expect(ids.length).toBeGreaterThan(4);
    expect((await mB.query(`SELECT count(*)::int AS n FROM payroll_payout_items WHERE id = ANY($1::uuid[])`, [ids]))[0].n).toBe(0);
    expect((await mB.query(`SELECT count(*)::int AS n FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollPayoutItem'`))[0].n).toBe(0);
    expect((await mB.query(`SELECT count(*)::int AS n FROM treasury_transactions WHERE "payrollRunId" IS NOT NULL`))[0].n).toBe(0);
  });
});
