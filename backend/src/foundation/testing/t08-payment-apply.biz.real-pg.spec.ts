import { randomUUID } from 'crypto';
import { abortBiz, attempt, auditChainValid, finishBiz, record, result, tally, widePool } from './biz-support';
import { reconcileAndRecord } from './biz-reconcile';
import { FinEnv, seedPostedInvoice, setUpFinance } from './biz-finance-support';

/**
 * T-08 (REQ-FIN-001) — FROZEN in docs/decisions/test-program/T-PLAN-FROZEN-2026-10-10.md.
 * Fixture: on-account payment 500.00 (unapplied) and two open invoices of 600.00 each.
 * Steps: two concurrent applications of 300.00 — (a) onto two different invoices, (b) onto the same invoice.
 * Expected: exactly one succeeds, the other is refused ("only 200.00 of payment ... is unapplied"); total applied <= 500.00;
 *           unapplied remaining = 200.00; customer ledger entries for the payment = original + the two rows of ONE application.
 * Repeated for 10 rounds; any deviation in any round is STOP. Disposable databases `daii_test_biz_t08_*` only.
 */
describe('T-08 — concurrent applications of one payment never exceed its unapplied amount', () => {
  jest.setTimeout(1_800_000);
  let env: FinEnv | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('300 + 300 against 500 unapplied', async () => {
    try {
      env = await setUpFinance('T-08', 'biz_t08');
      const e = env;
      const wide = await widePool(e, 20);
      await e.treasury.cashIn(e.bankAccountId, '10000.00', null, null, null, 'T-08 funding', e.actor, e.manager);
      let stop = false;
      const rounds: unknown[] = [];

      for (const variant of ['a-two-invoices', 'b-same-invoice'] as const) {
        for (let round = 1; round <= 10 && !stop; round += 1) {
          const pay = await e.payments.recordOnAccountPayment(e.customerId, null, '500.00', 'bank_transfer', e.bankAccountId, `T08-${variant}-${round}`, e.actor, e.manager);
          const i1 = await seedPostedInvoice(e, e.dsA, '600.00', `${variant}-${round}-1`);
          const i2 = variant === 'a-two-invoices' ? await seedPostedInvoice(e, e.dsA, '600.00', `${variant}-${round}-2`) : i1;
          const outs = await Promise.all([i1, i2].map((inv) => attempt(() => e.payments.applyPayment(pay.id, inv, '300.00', e.actor, wide.manager))));
          const unapplied = await e.payments.getUnappliedBalance(pay.id, e.manager);
          const appRows = (await e.dsA.query(`SELECT count(*)::int AS n FROM customer_ledger_entries WHERE "paymentId" = $1 AND "entryType" = 'payment_application'`, [pay.id]))[0].n;
          const t = tally(outs);
          const refused = outs.filter((o) => !o.ok);
          const st = { variant, round, tally: t, unapplied, applicationRows: appRows, refusedMessages: refused.map((r) => r.message) };
          rounds.push(st);
          const ok = t.OK === 1 && t['ConflictException:409'] === 1 && Object.keys(t).length === 2 && /only 200\.00 of payment/.test(refused[0].message ?? '') && unapplied === '200.00' && appRows === 2;
          if (!ok) { stop = true; result(e, `T-08-${variant}-R${round}`, 'STOP', JSON.stringify(st)); }
        }
        if (!stop) result(e, `T-08-${variant}`, 'PASS', '10 rounds: one application succeeds, the other is refused, unapplied = 200.00, exactly one application (2 ledger rows)');
      }
      record(e, 'T-08-rounds.json', rounds);

      // AR sub-ledger vs GL (AR control account 1110) after the run — informational input for T-10/R3
      const subledger = (await e.dsA.query(`SELECT coalesce(sum(CASE WHEN direction = 'debit' THEN amount ELSE -amount END),0)::text AS t FROM customer_ledger_entries`))[0].t;
      const glAr = (await e.dsA.query(`SELECT coalesce(sum(jl."debitBase" - jl."creditBase"),0)::text AS t FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE ga."controlFunction" = 'ar'`))[0].t;
      record(e, 'T-08-ar-reconciliation-input.json', { customerLedgerNet: subledger, glArNet: glAr, note: 'seeded posted invoices (direct inserts) have no ledger/GL rows by construction; R3 is evaluated in T-10 on the declared baseline' });

      result(e, 'invariant-audit-chain-valid', (await auditChainValid(e)) ? 'PASS' : 'STOP');
      void randomUUID;
      await reconcileAndRecord(e, { nonGlTreasury: 10000, notes: ['10000.00 funding cash-in is deliberately non-emitting'] });
      await finishBiz(e);
      expect(e.results.filter((r) => r.status === 'FAIL' || r.status === 'STOP')).toEqual([]);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
