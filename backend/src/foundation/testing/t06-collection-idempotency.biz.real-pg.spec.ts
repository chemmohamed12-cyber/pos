import { randomUUID } from 'crypto';
import { abortBiz, attempt, auditProbe, finishBiz, record, result, tally, widePool } from './biz-support';
import { reconcileAndRecord } from './biz-reconcile';
import { FinEnv, glLinesFor, seedPostedInvoice, setUpFinance } from './biz-finance-support';
import { TreasuryController } from '../../domains/treasury/interface/treasury.controller';

/**
 * T-06 (REQ-FIN-002) — FROZEN in docs/decisions/test-program/T-PLAN-FROZEN-2026-10-10.md.
 * Fixture: customer C, posted sales invoice 1000.00, GL-mapped bank account (1102).
 * The collection endpoint is exercised exactly as PaymentsController composes it:
 *   IdempotencyService.withIdempotencyInTransaction('payments.record', key, tx => PaymentsService.recordPayment(...)).
 * Steps / Expected (frozen): same key K — (1) 3 sequential calls, (2) 5 concurrent calls: ONE effect (one payment row, one treasury
 * movement of +400.00, one customer-ledger payment entry, one GL event 1102 D 400.00 / 1110 C 400.00, invoice remaining 600.00);
 * (3) a different key K2 is a second, independent effect (positive control).
 *
 * T-06x (informational, OUTSIDE the frozen scope — reported as a FINDING, never changes the T-06 verdict): the same replay questions for the
 * treasury cash-in endpoint, which TreasuryController wraps in the NON-transactional IdempotencyService.withIdempotency (operation runs before
 * the dedup record is written). Recorded so the CTO can decide whether it needs its own frozen case.
 * Disposable databases `daii_test_biz_t06_*` only.
 */
describe('T-06 — a replayed collection request has exactly one financial effect', () => {
  jest.setTimeout(1_800_000);
  let env: FinEnv | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  const collect = (e: FinEnv, key: string, invoiceId: string, m = e.manager) =>
    e.idempotency.withIdempotencyInTransaction('payments.record', key, (tx) => e.payments.recordPayment(e.customerId, invoiceId, '400.00', 'bank_transfer', e.bankAccountId, null, e.actor, tx), m);

  async function effects(e: FinEnv, invoiceId: string) {
    const pays: Array<{ id: string }> = await e.dsA.query(`SELECT id FROM customer_payments WHERE "invoiceId" = $1`, [invoiceId]);
    const treasuryRows = (await e.dsA.query(
      `SELECT count(*)::int AS n, coalesce(sum(amount),0)::text AS s FROM treasury_transactions WHERE type = 'cash_in' AND id IN (SELECT "treasuryTransactionId" FROM customer_payments WHERE "invoiceId" = $1)`, [invoiceId],
    ))[0];
    const ledger = (await e.dsA.query(`SELECT count(*)::int AS n FROM customer_ledger_entries WHERE "invoiceId" = $1 OR "paymentId" IN (SELECT id FROM customer_payments WHERE "invoiceId" = $1)`, [invoiceId]))[0].n;
    const remaining = await e.payments['invoices'].getInvoiceRemaining(invoiceId, e.manager);
    const gl = pays.length ? await glLinesFor(e.dsA, pays[0].id) : null;
    return { payments: pays.length, treasuryRows: treasuryRows.n, treasuryTotal: treasuryRows.s, ledgerEntries: ledger, remaining, gl };
  }

  it('same key replayed: one effect; different key: a second effect', async () => {
    try {
      env = await setUpFinance('T-06', 'biz_t06');
      const e = env;
      const wide = await widePool(e, 30);
      await e.treasury.cashIn(e.bankAccountId, '5000.00', null, null, null, 'T-06 funding', e.actor, e.manager);

      // ---- (1) three sequential calls, same key ----
      const inv1 = await seedPostedInvoice(e, e.dsA, '1000.00', 'seq');
      const k1 = `T06-SEQ-${randomUUID()}`;
      const seq = [await attempt(() => collect(e, k1, inv1)), await attempt(() => collect(e, k1, inv1)), await attempt(() => collect(e, k1, inv1))];
      await e.events.dispatchAfterCommit(e.manager);
      const eff1 = await effects(e, inv1);
      record(e, 'T-06-sequential.json', { outcomes: seq, effects: eff1 });
      const ok1 = seq.every((o) => o.ok) && eff1.payments === 1 && eff1.treasuryRows === 1 && Number(eff1.treasuryTotal) === 400 && eff1.ledgerEntries >= 1 && Number(eff1.remaining) === 600 &&
        eff1.gl?.status === 'POSTED' && JSON.stringify(eff1.gl.lines) === JSON.stringify(['1102 D 400.00', '1110 C 400.00']);
      result(e, 'T-06-1-sequential', ok1 ? 'PASS' : 'STOP', JSON.stringify(eff1));

      // ---- (2) five concurrent calls, same key (own connections) ----
      const inv2 = await seedPostedInvoice(e, e.dsA, '1000.00', 'conc');
      const k2 = `T06-CONC-${randomUUID()}`;
      const conc = await Promise.all(Array.from({ length: 5 }, () => attempt(() => collect(e, k2, inv2, wide.manager))));
      await e.events.dispatchAfterCommit(e.manager);
      const eff2 = await effects(e, inv2);
      record(e, 'T-06-concurrent.json', { tally: tally(conc), effects: eff2 });
      const ok2 = conc.every((o) => o.ok) && eff2.payments === 1 && eff2.treasuryRows === 1 && Number(eff2.treasuryTotal) === 400 && Number(eff2.remaining) === 600 &&
        eff2.gl?.status === 'POSTED' && JSON.stringify(eff2.gl.lines) === JSON.stringify(['1102 D 400.00', '1110 C 400.00']);
      result(e, 'T-06-2-concurrent', ok2 ? 'PASS' : 'STOP', JSON.stringify({ tally: tally(conc), effects: eff2 }));

      // ---- (3) positive control: a different key is a second, independent effect on the same invoice ----
      const out3 = await attempt(() => collect(e, `T06-OTHER-${randomUUID()}`, inv2));
      await e.events.dispatchAfterCommit(e.manager);
      const eff3 = await effects(e, inv2);
      result(e, 'T-06-3-different-key', out3.ok && eff3.payments === 2 && Number(eff3.remaining) === 200 ? 'PASS' : 'STOP', JSON.stringify({ out3, eff3 }));

      // ---- T-06x (informational): treasury cash-in endpoint composition, non-transactional idempotency ----
      const kx = `T06X-${randomUUID()}`;
      const before = (await e.dsA.query(`SELECT count(*)::int AS n FROM treasury_transactions WHERE reference = $1`, [kx]))[0].n;
      const xs = await Promise.all(Array.from({ length: 5 }, () => attempt(() => e.idempotency.withIdempotency('treasury.cash_in', kx, () => e.treasury.cashInDirect(e.bankAccountId, '10.00', null, null, kx, 'T-06x', e.actor, wide.manager), wide.manager))));
      await e.events.dispatchAfterCommit(e.manager);
      const rows = (await e.dsA.query(`SELECT count(*)::int AS n FROM treasury_transactions WHERE reference = $1`, [kx]))[0].n;
      record(e, 'T-06x-treasury-cashin.json', { before, afterRows: rows, tally: tally(xs) });
      result(e, 'T-06x-INFO', rows === 1 ? 'PASS' : 'FAIL-DEFECT', `treasury cash-in with the SAME idempotency key sent 5x concurrently produced ${rows} treasury movement(s) (INFORMATIONAL — outside the frozen T-06 scope)`);

      // ---- T-06y (informational, after remediation of T-06x): the REAL TreasuryController composition (withIdempotencyInTransaction) with a plain Company manager ----
      const controller = new TreasuryController(e.treasury, e.idempotency, e.events);
      const fakeReq = { user: { id: e.actor }, companyContext: { dataSource: wide } } as never;
      const ky = `T06Y-${randomUUID()}`;
      const ysRaw = await Promise.allSettled(Array.from({ length: 5 }, () => controller.cashIn(fakeReq, { accountId: e.bankAccountId, amount: '10.00', reference: ky, reason: 'T-06y' } as never, ky)));
      const ys = ysRaw.map((r) => (r.status === 'fulfilled' ? { ok: true, kind: 'OK' } : { ok: false, kind: String((r.reason as Error)?.message).slice(0, 80) }));
      const yRows = (await e.dsA.query(`SELECT count(*)::int AS n FROM treasury_transactions WHERE reference = $1`, [ky]))[0].n;
      const ids = new Set(ysRaw.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id));
      const ky2 = `T06Y-${randomUUID()}`;
      const y2 = await attempt(() => controller.cashIn(fakeReq, { accountId: e.bankAccountId, amount: '10.00', reference: ky2, reason: 'T-06y' } as never, ky2));
      const yRows2 = (await e.dsA.query(`SELECT count(*)::int AS n FROM treasury_transactions WHERE reference = $1`, [ky2]))[0].n;
      record(e, 'T-06y-controller-cashin.json', { sameKeyRows: yRows, outcomes: ys, distinctResultIds: ids.size, differentKeyOk: y2.ok, differentKeyRows: yRows2 });
      result(e, 'T-06y-CONTROLLER', yRows === 1 && ids.size === 1 && y2.ok && yRows2 === 1 ? 'PASS' : 'FAIL-DEFECT', `TreasuryController.cashIn, same Idempotency-Key 5x concurrently: ${yRows} movement(s), ${ids.size} distinct result id(s); different key: ${yRows2} movement`);

      await auditProbe(e, 'final');
      await reconcileAndRecord(e, { nonGlTreasury: 5000, notes: ['5000.00 funding cash-in is deliberately non-emitting'] });
      await finishBiz(e);
      expect(e.results.filter((r) => r.status === 'FAIL' || r.status === 'STOP')).toEqual([]);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
