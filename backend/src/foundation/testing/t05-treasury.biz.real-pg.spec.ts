import { abortBiz, attempt, auditProbe, finishBiz, record, result, tally, widePool } from './biz-support';
import { reconcileAndRecord } from './biz-reconcile';
import { FinEnv, glLinesFor, setUpFinance } from './biz-finance-support';

/**
 * T-05 (REQ-CON-003, treasury) — FROZEN in docs/decisions/test-program/T-PLAN-FROZEN-2026-10-10.md.
 * Fixture: GL-mapped (1102) treasury account, opening cash-in 100.00 (one non-emitting movement).
 * Steps: 10 concurrent cash-outs of 30.00 through the emitting operation (cashOutDirect).
 * Expected: exactly 3 succeed; balance 10.00; 7 refused with "Insufficient treasury balance"; treasury movements = 1 + 3;
 *           after the event engine: 3 POSTED events whose journals are 1102 C 30.00 / <offset> D 30.00 pattern (see below); none REJECTED/PENDING.
 * Disposable databases `daii_test_biz_t05_*` only.
 */
describe('T-05 — concurrent treasury withdrawals never exceed the balance', () => {
  jest.setTimeout(1_800_000);
  let env: FinEnv | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('10 x 30.00 from 100.00', async () => {
    try {
      env = await setUpFinance('T-05', 'biz_t05');
      const e = env;
      const wide = await widePool(e, 30);
      const M = wide.manager;

      await e.treasury.cashIn(e.bankAccountId, '100.00', null, null, null, 'T-05 opening', e.actor, e.manager); // the frozen opening movement
      let funded = 1;
      let stop = false;
      const rounds: unknown[] = [];

      // the frozen scenario is ONE round on a fresh account; two further rounds on fresh accounts repeat it (no averaging: any deviation is STOP)
      for (let round = 1; round <= 3 && !stop; round += 1) {
        let accountId = e.bankAccountId;
        if (round > 1) {
          const types = await e.treasury.listAccountTypes(e.manager);
          const a = await e.treasury.createAccount(`BIZ-BANK-R${round}`, `Biz Bank R${round}`, types.find((t) => t.code === 'bank')!.id, e.actor, e.manager);
          await e.treasury.setAccountGlMapping(a.id, '1102', e.actor, e.manager);
          await e.treasury.cashIn(a.id, '100.00', null, null, null, `T-05 opening R${round}`, e.actor, e.manager);
          funded += 1;
          accountId = a.id;
        }
        const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => attempt(async () => (await e.treasury.cashOutDirect(accountId, '30.00', null, null, `T05-R${round}-${i}`, 'T-05', e.actor, M)).id)));
        await e.events.dispatchAfterCommit(e.manager);
        const t = tally(outs);
        const balance = await e.treasury.getAccountBalance(accountId, e.manager);
        const txns = (await e.dsA.query(`SELECT count(*)::int AS n, coalesce(sum(amount) FILTER (WHERE type = 'cash_out'),0)::text AS out FROM treasury_transactions WHERE "treasuryAccountId" = $1`, [accountId]))[0];
        const events = await e.dsA.query(`SELECT status, count(*)::int AS n FROM accounting_financial_events WHERE "sourceEntityId"::text IN (SELECT id::text FROM treasury_transactions WHERE "treasuryAccountId" = $1 AND type = 'cash_out') GROUP BY 1`, [accountId]);
        const refusedMsgOk = outs.filter((o) => !o.ok).every((o) => /Insufficient treasury balance/.test(o.message ?? ''));
        const errorsByMessage = Object.entries(outs.filter((o) => !o.ok).reduce<Record<string, number>>((m, o) => ({ ...m, [`${o.kind} | ${o.pgCode ?? '-'} | ${o.message}`]: (m[`${o.kind} | ${o.pgCode ?? '-'} | ${o.message}`] ?? 0) + 1 }), {}));
        const state = { round, tally: t, errorsByMessage, balance, treasuryMovements: txns.n, cashOutTotal: txns.out, events };
        rounds.push(state);
        const ok = t.OK === 3 && t['ConflictException:409'] === 7 && Object.keys(t).length === 2 && refusedMsgOk && balance === '10.00' && txns.n === 4 && Number(txns.out) === 90 &&
          events.length === 1 && events[0].status === 'POSTED' && events[0].n === 3;
        if (!ok) {
          stop = true;
          const overdraft = Number(balance) < 0;
          result(e, `T-05-R${round}`, 'FAIL-DEFECT', `CANDIDATE PRODUCT DEFECT F-TRS-001 (${overdraft ? 'OVERDRAFT: negative treasury balance' : 'unexpected error kinds under concurrency'}); root cause by code reading: TreasuryService.run(manager, fn) runs fn directly on the supplied manager (no transaction) and the controller supplies dataSource.manager, so the per-account advisory lock is not held across the balance check and the insert. ${JSON.stringify(state)}`);
        }
      }
      record(e, 'T-05-rounds.json', rounds);

      // GL: each successful withdrawal produced a balanced journal crediting the mapped bank account 1102 by 30.00
      const gl = await e.dsA.query(
        `SELECT ga.code, sum(jl."debitBase")::text AS dr, sum(jl."creditBase")::text AS cr FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" GROUP BY 1 ORDER BY 1`,
      );
      const bank = gl.find((r: { code: string }) => r.code === '1102');
      const clearing = gl.find((r: { code: string }) => r.code === '1199');
      const unbalanced = await e.dsA.query(`SELECT "journalEntryId" FROM accounting_journal_lines GROUP BY 1 HAVING SUM("debitBase") <> SUM("creditBase")`);
      record(e, 'T-05-gl.json', { gl, unbalanced });
      const outTotal = Number((await e.dsA.query(`SELECT coalesce(sum(amount),0)::text AS s FROM treasury_transactions WHERE type = 'cash_out'`))[0].s);
      const glOk = !!bank && Number(bank.cr) === outTotal && !!clearing && Number(clearing.dr) === outTotal && unbalanced.length === 0; // every successful withdrawal: Cr 1102 bank / Dr 1199 clearing, journals balanced
      result(e, 'T-05-gl', glOk ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ bank, clearing, outTotal, unbalanced: unbalanced.length }));
      void glLinesFor;

      if (!stop) result(e, 'T-05', 'PASS', '3 rounds: exactly 3 of 10 withdrawals succeed, balance 10.00, 7 refused with the insufficient-balance error, movements 1+3, events POSTED');
      await auditProbe(e, 'final');

      await reconcileAndRecord(e, { nonGlTreasury: funded * 100, notes: [`${funded} opening cash-in(s) of 100.00 are deliberately non-emitting (no GL event)`] });
      await finishBiz(e);
      expect(e.results.filter((r) => r.status === 'FAIL' || r.status === 'STOP')).toEqual([]);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
