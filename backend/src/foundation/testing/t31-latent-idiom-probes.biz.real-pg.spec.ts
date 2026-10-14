import { abortBiz, attempt, finishBiz, record, result, tally, widePool } from './biz-support';
import { FinEnv, seedPostedInvoice, setUpFinance } from './biz-finance-support';

/**
 * T-31 — LATENT plain-manager probes (TASK 5 of the post-C14 sequence; TEST-ONLY; changes no product logic; outside the frozen T-xx set).
 * A scan of production code for the lock-losing idiom `manager ? run(manager) : dataSource.transaction(run)` (the N-01/N-02 class) found three sites that were not
 * covered by T-19/T-24/T-30: `PaymentsService.recordPayment` and `recordOnAccountPayment` (payments.service.ts), and the private `run` of `MovingAverageCostEngine`.
 * Reach by reading: the HTTP path of `recordPayment` is wrapped by `IdempotencyService.withIdempotencyInTransaction` (a transaction manager); the cost engine is called from
 * `recordMovement` inside its own transaction. This probe measures what a plain manager would do if a future caller passed one — it does NOT claim a reachable defect.
 *   P1  recordPayment: 8 concurrent payments of 60.00 against an invoice with 100.00 remaining must leave exactly one success (A: plain manager, B: transaction manager).
 * Disposable databases `daii_test_biz_t31_*` only.
 */
describe('T-31 — latent plain-manager probe: concurrent customer payments never exceed the invoice remaining', () => {
  jest.setTimeout(900_000);
  let env: FinEnv | undefined;
  let failure: unknown;
  afterAll(async () => { if (env) await abortBiz(env, failure); });

  it('P1 recordPayment, both calling styles', async () => {
    try {
      env = await setUpFinance('T-31', 'biz_t31');
      const e = env;
      const wide = await widePool(e, 30);
      await e.treasury.cashIn(e.bankAccountId, '10000.00', null, null, null, 'T-31 funding', e.actor, e.manager);
      const detail: Record<string, unknown> = {};
      for (const style of ['plain', 'transaction'] as const) {
        const rounds: Array<Record<string, unknown>> = [];
        let allSafe = true;
        for (let round = 0; round < 3; round += 1) {
          const inv = await seedPostedInvoice(e, e.dsA, '100.00', `p1${style[0]}${round}`);
          const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => attempt(() => (style === 'plain'
            ? e.payments.recordPayment(e.customerId, inv, '60.00', 'bank_transfer', e.bankAccountId, `T31-${style}-${round}-${i}`, e.actor, wide.manager)
            : wide.manager.transaction((tx) => e.payments.recordPayment(e.customerId, inv, '60.00', 'bank_transfer', e.bankAccountId, `T31-${style}-${round}-${i}`, e.actor, tx))))));
          const ok = outs.filter((o) => o.ok).length;
          const paid = Number((await e.dsA.query(`SELECT coalesce(sum(amount),0)::text AS s FROM customer_payments WHERE "invoiceId" = $1`, [inv]))[0].s);
          const d = { round, calls: 8, ok, tally: tally(outs), paidTotal: paid, invoiceTotal: 100 };
          rounds.push(d);
          allSafe = allSafe && ok === 1 && paid === 60;
        }
        detail[`P1-${style}`] = rounds;
        result(e, `P1-${style === 'plain' ? 'A-plain-manager' : 'B-transaction-manager'}-concurrent-payments-never-overpay`, allSafe ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(rounds));
      }
      record(e, 'T-31-detail.json', detail);
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
