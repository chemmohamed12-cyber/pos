import { randomUUID } from 'crypto';
import { abortBiz, attempt, auditChainValid, finishBiz, record, result, tally, widePool } from './biz-support';
import { FinEnv, seedPostedInvoice, setUpFinance } from './biz-finance-support';

/**
 * T-31 — plain-manager probes for customer payments (found by the TASK 5 class scan; C15 reproduction and, after the CTO's authorisation of 2026-10-14, its REGRESSION test; outside the frozen T-xx set). The product fix is `payments.service.ts` (`recordPayment`, `recordOnAccountPayment` through `runInTransaction`); before it, P1-A, P5-A recordPayment and P5-A recordOnAccountPayment were FAIL-DEFECT.
 * A scan of production code for the lock-losing idiom `manager ? run(manager) : dataSource.transaction(run)` (the N-01/N-02 class) found three sites that were not
 * covered by T-19/T-24/T-30: `PaymentsService.recordPayment` and `recordOnAccountPayment` (payments.service.ts), and the private `run` of `MovingAverageCostEngine`.
 * Reach by reading: the HTTP path of `recordPayment` is wrapped by `IdempotencyService.withIdempotencyInTransaction` (a transaction manager); the cost engine is called from
 * `recordMovement` inside its own transaction. This probe measures what a plain manager would do if a future caller passed one — it does NOT claim a reachable defect.
 *   P1  recordPayment: 8 concurrent payments of 60.00 against an invoice with 100.00 remaining must leave exactly one success (A: plain manager, B: transaction manager).
 *       Per round it also records every side effect of a payment so that "money accepted" and "records written" can be compared: payments, customer-ledger credits,
 *       distinct treasury transactions, `customer_finance.payment.recorded` audit rows, and the invoice remaining.
 *   P2  rollback: a payment recorded inside an outer transaction that is rolled back leaves no payment, ledger credit, treasury transaction or audit row, and the treasury
 *       balance unchanged (transaction manager only — a plain manager has no transaction to roll back).
 *   P4  a single payment inside the balance behaves exactly as before and the exact remainder is accepted, then nothing more (both calling styles).
 *   P5  a failure part-way (the ledger credit throws after the treasury cash-in) leaves no payment row, no orphan cash-in and an unchanged balance, for recordPayment and
 *       recordOnAccountPayment, in both calling styles; a retry then succeeds.
 *   P3  after everything above, the company audit chain is valid.
 * Disposable databases `daii_test_biz_t31_*` only.
 */
describe('T-31 — latent plain-manager probe: concurrent customer payments never exceed the invoice remaining', () => {
  jest.setTimeout(900_000);
  let env: FinEnv | undefined;
  let failure: unknown;
  afterAll(async () => { if (env) await abortBiz(env, failure); });

  it('P1 recordPayment in both calling styles, P2 rollback, P3 audit chain', async () => {
    try {
      env = await setUpFinance('T-31', 'biz_t31');
      const e = env;
      const wide = await widePool(e, 30);
      await e.treasury.cashIn(e.bankAccountId, '10000.00', null, null, null, 'T-31 funding', e.actor, e.manager);
      const detail: Record<string, unknown> = {};
      const n = async (sql: string, params: unknown[]) => Number((await e.dsA.query(sql, params))[0].n);
      const effects = async (invoiceId: string) => ({
        payments: await n(`SELECT count(*)::int AS n FROM customer_payments WHERE "invoiceId" = $1`, [invoiceId]),
        paidTotal: Number((await e.dsA.query(`SELECT coalesce(sum(amount),0)::text AS s FROM customer_payments WHERE "invoiceId" = $1`, [invoiceId]))[0].s),
        ledgerCredits: await n(`SELECT count(*)::int AS n FROM customer_ledger_entries WHERE "invoiceId" = $1 AND "entryType" = 'payment'`, [invoiceId]),
        treasuryTxns: await n(`SELECT count(DISTINCT "treasuryTransactionId")::int AS n FROM customer_payments WHERE "invoiceId" = $1`, [invoiceId]),
        auditRows: await n(`SELECT count(*)::int AS n FROM audit_records WHERE action = 'customer_finance.payment.recorded' AND (after->>'invoiceId') = $1`, [invoiceId]),
      });

      // ---------------- P1 ----------------
      for (const style of ['plain', 'transaction'] as const) {
        const rounds: Array<Record<string, unknown>> = [];
        let allSafe = true;
        for (let round = 0; round < 3; round += 1) {
          const inv = await seedPostedInvoice(e, e.dsA, '100.00', `p1${style[0]}${round}`);
          const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => attempt(() => (style === 'plain'
            ? e.payments.recordPayment(e.customerId, inv, '60.00', 'bank_transfer', e.bankAccountId, `T31-${style}-${round}-${i}`, e.actor, wide.manager)
            : wide.manager.transaction((tx) => e.payments.recordPayment(e.customerId, inv, '60.00', 'bank_transfer', e.bankAccountId, `T31-${style}-${round}-${i}`, e.actor, tx))))));
          const ok = outs.filter((o) => o.ok).length;
          const fx = await effects(inv);
          const d = { round, calls: 8, ok, tally: tally(outs), invoiceTotal: 100, remainingAfter: 100 - fx.paidTotal, ...fx };
          rounds.push(d);
          // safe = at most the invoice is paid: exactly one 60.00 payment, and every side effect exists exactly once
          allSafe = allSafe && ok === 1 && fx.paidTotal === 60 && fx.payments === 1 && fx.ledgerCredits === 1 && fx.treasuryTxns === 1 && fx.auditRows === 1;
        }
        detail[`P1-${style}`] = rounds;
        result(e, `P1-${style === 'plain' ? 'A-plain-manager' : 'B-transaction-manager'}-concurrent-payments-never-overpay`, allSafe ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(rounds));
      }

      // ---------------- P2 rollback ----------------
      {
        const inv = await seedPostedInvoice(e, e.dsA, '100.00', 'p2');
        const balanceBefore = await e.treasury.getAccountBalance(e.bankAccountId, e.manager);
        const out = await attempt(() => wide.manager.transaction(async (tx) => {
          await e.payments.recordPayment(e.customerId, inv, '40.00', 'bank_transfer', e.bankAccountId, `T31-rollback-${randomUUID().slice(0, 6)}`, e.actor, tx);
          throw new Error('forced rollback');
        }));
        const fx = await effects(inv);
        const balanceAfter = await e.treasury.getAccountBalance(e.bankAccountId, e.manager);
        detail['P2-rollback'] = { rolledBack: !out.ok, balanceBefore, balanceAfter, ...fx };
        const retry = await attempt(() => e.payments.recordPayment(e.customerId, inv, '40.00', 'bank_transfer', e.bankAccountId, 'T31-retry', e.actor, wide.manager));
        const fxRetry = await effects(inv);
        detail['P2-retry'] = { retryOk: retry.ok, ...fxRetry };
        result(e, 'P2-outer-rollback-leaves-no-payment-ledger-treasury-or-audit-trace', !out.ok && fx.payments === 0 && fx.ledgerCredits === 0 && fx.treasuryTxns === 0 && fx.auditRows === 0 && balanceBefore === balanceAfter && retry.ok && fxRetry.payments === 1 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['P2-rollback']) + ' / ' + JSON.stringify(detail['P2-retry']));
      }

      // ---------------- P4 a single payment inside the balance behaves exactly as before (both calling styles) ----------------
      for (const style of ['plain', 'transaction'] as const) {
        const inv = await seedPostedInvoice(e, e.dsA, '100.00', `p4${style[0]}`);
        const before = await e.treasury.getAccountBalance(e.bankAccountId, e.manager);
        const pay = await (style === 'plain'
          ? e.payments.recordPayment(e.customerId, inv, '60.00', 'bank_transfer', e.bankAccountId, `T31-single-${style}`, e.actor, wide.manager)
          : wide.manager.transaction((tx) => e.payments.recordPayment(e.customerId, inv, '60.00', 'bank_transfer', e.bankAccountId, `T31-single-${style}`, e.actor, tx)));
        const fx = await effects(inv);
        const after = await e.treasury.getAccountBalance(e.bankAccountId, e.manager);
        const second = await attempt(() => e.payments.recordPayment(e.customerId, inv, '60.00', 'bank_transfer', e.bankAccountId, `T31-single2-${style}`, e.actor, wide.manager)); // 40.00 remains: refused
        const third = await attempt(() => e.payments.recordPayment(e.customerId, inv, '40.00', 'bank_transfer', e.bankAccountId, `T31-single3-${style}`, e.actor, wide.manager)); // exactly the remainder: accepted
        const fxEnd = await effects(inv);
        detail[`P4-${style}`] = { paymentId: pay.id, balanceDelta: Number(after) - Number(before), ...fx, secondRefused: !second.ok && second.kind === 'ConflictException:409', remainderAccepted: third.ok, ...{ end: fxEnd } };
        result(e, `P4-${style === 'plain' ? 'A-plain-manager' : 'B-transaction-manager'}-single-payment-and-exact-remainder`, Number(after) - Number(before) === 60 && fx.payments === 1 && fx.ledgerCredits === 1 && fx.treasuryTxns === 1 && fx.auditRows === 1 && !second.ok && second.kind === 'ConflictException:409' && third.ok && fxEnd.paidTotal === 100 && fxEnd.payments === 2 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail[`P4-${style}`]));
      }

      // ---------------- P5 a failure part-way (after the treasury cash-in) is all-or-nothing, plain manager and transaction manager ----------------
      {
        const ledger = (e.payments as unknown as { ledger: { postEntry: (...a: unknown[]) => Promise<unknown> } }).ledger;
        for (const method of ['recordPayment', 'recordOnAccountPayment'] as const) {
          for (const style of ['plain', 'transaction'] as const) {
            const inv = method === 'recordPayment' ? await seedPostedInvoice(e, e.dsA, '100.00', `p5${style[0]}`) : null;
            const ref = `T31-fail-${method}-${style}`;
            const before = await e.treasury.getAccountBalance(e.bankAccountId, e.manager);
            const spy = jest.spyOn(ledger, 'postEntry').mockRejectedValueOnce(new Error('forced failure after the treasury cash-in'));
            const call = (m: import('typeorm').EntityManager) => (method === 'recordPayment'
              ? e.payments.recordPayment(e.customerId, inv as string, '50.00', 'bank_transfer', e.bankAccountId, ref, e.actor, m)
              : e.payments.recordOnAccountPayment(e.customerId, null, '50.00', 'bank_transfer', e.bankAccountId, ref, e.actor, m));
            const out = await attempt(() => (style === 'plain' ? call(wide.manager) : wide.manager.transaction((tx) => call(tx))));
            spy.mockRestore();
            const after = await e.treasury.getAccountBalance(e.bankAccountId, e.manager);
            const payRows = await n(`SELECT count(*)::int AS n FROM customer_payments WHERE reference = $1`, [ref]);
            const cashRows = await n(`SELECT count(*)::int AS n FROM treasury_transactions WHERE "treasuryAccountId" = $1 AND amount = 50 AND "createdAt" > now() - interval '5 minutes' AND id NOT IN (SELECT "treasuryTransactionId" FROM customer_payments WHERE "treasuryTransactionId" IS NOT NULL)`, [e.bankAccountId]);
            const retry = await attempt(() => call(wide.manager));
            const d = { method, style, failed: !out.ok, balanceBefore: before, balanceAfter: after, paymentRows: payRows, orphanCashIn: cashRows, retryOk: retry.ok };
            detail[`P5-${method}-${style}`] = d;
            result(e, `P5-${style === 'plain' ? 'A-plain-manager' : 'B-transaction-manager'}-${method}-failure-after-cash-in-is-all-or-nothing`, !out.ok && before === after && payRows === 0 && cashRows === 0 && retry.ok ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(d));
          }
        }
      }

      // ---------------- P3 audit chain ----------------
      {
        const valid = await auditChainValid(e);
        detail['P3'] = { chainValid: valid };
        result(e, 'P3-audit-chain-valid-after-all-payment-probes', valid ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['P3']));
      }

      record(e, 'T-31-detail.json', detail);
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
