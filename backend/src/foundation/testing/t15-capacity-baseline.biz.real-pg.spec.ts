import { cpus, totalmem } from 'os';
import { FinEnv, setUpFinance } from './biz-finance-support';
import { abortBiz, auditProbe, finishBiz, negativeStockPairs, onHand, receive, record, reserved, result, seedProduct, widePool } from './biz-support';
import { reconcileAndRecord } from './biz-reconcile';

/**
 * T-15 — LOCAL CAPACITY BASELINE (informational; NOT part of the frozen T-01…T-12 set and NOT an acceptance test against approved numbers).
 * Decision D-10 (target concurrent users / SLOs) has no approved source; therefore this test applies NO latency/throughput threshold. It measures, on the
 * dedicated local cluster, how four core write paths behave as the number of simultaneously in-flight operations grows (1, 5, 10, 25, 50), and verifies that
 * correctness invariants still hold under that load (zero errors, audit chain intact, balances/ledgers/stock exact, reconciliation R1–R10).
 * "Concurrency" here = simultaneous in-flight database operations through the service layer with a plain Company manager (the controller-equivalent
 * path), NOT HTTP users. Hardware limits are recorded with the result; the numbers cannot be extrapolated to hosting.
 * Operations: A) audit.record  B) treasury cash-out (single hot account)  C) on-account payment (transactional, as the controller)  D) stock reservation (single hot product).
 * Disposable databases `daii_test_biz_t15_*` only.
 */
const LEVELS = [1, 5, 10, 25, 50];
const opsFor = (level: number) => Math.max(20, level * 4);

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function drive<T>(total: number, level: number, op: (i: number) => Promise<T>): Promise<{ ok: number; errors: string[]; ms: number[]; wallMs: number }> {
  const ms: number[] = [];
  const errors: string[] = [];
  let next = 0;
  let ok = 0;
  const t0 = Date.now();
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const s = Date.now();
      try { await op(i); ok += 1; } catch (e) { errors.push(String((e as Error)?.message ?? e).slice(0, 120)); }
      ms.push(Date.now() - s);
    }
  };
  await Promise.all(Array.from({ length: level }, worker));
  return { ok, errors, ms: ms.sort((a, b) => a - b), wallMs: Date.now() - t0 };
}

describe('T-15 — local capacity baseline with correctness invariants under rising concurrency', () => {
  jest.setTimeout(3_600_000);
  let env: FinEnv | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('1/5/10/25/50 in-flight operations on four write paths', async () => {
    try {
      env = await setUpFinance('T-15', 'biz_t15');
      const e = env;
      const wide = await widePool(e, 60);
      const maxConn = (await e.dsA.query('SHOW max_connections'))[0].max_connections;
      const FUND = 1_000_000;
      await e.treasury.cashIn(e.bankAccountId, `${FUND}.00`, null, null, null, 'T-15 funding', e.actor, e.manager);
      const hot = await seedProduct(e.dsA, 'T15-HOT');
      await receive(e, e.warehouseId, hot, 100000);

      const table: Array<Record<string, unknown>> = [];
      let cashOutOk = 0;
      let paymentsOk = 0;
      let reservedOk = 0;
      let auditOk = 0;
      let allClean = true;
      const summarize = (name: string, level: number, total: number, r: Awaited<ReturnType<typeof drive>>) => {
        const row = { op: name, inFlight: level, operations: total, ok: r.ok, errors: r.errors.length, errorSamples: [...new Set(r.errors)].slice(0, 3), opsPerSec: Number((r.ok / (r.wallMs / 1000)).toFixed(1)), p50ms: pct(r.ms, 50), p95ms: pct(r.ms, 95), p99ms: pct(r.ms, 99), maxMs: r.ms[r.ms.length - 1], wallMs: r.wallMs };
        table.push(row);
        if (r.errors.length) allClean = false;
        return row;
      };

      for (const level of LEVELS) {
        const total = opsFor(level);
        const a = await drive(total, level, (i) => e.audit.record({ actorUserId: null, organizationId: null, action: 'capacity.probe', resource: 'x', resourceId: String(i), result: 'success', correlationId: null, after: { i } }, wide.manager));
        auditOk += a.ok; summarize('audit.record', level, total, a);

        const b = await drive(total, level, (i) => e.treasury.cashOut(e.bankAccountId, '1.00', null, null, `cap-${level}-${i}`, 'T-15', e.actor, wide.manager));
        cashOutOk += b.ok; summarize('treasury.cashOut(hot account)', level, total, b);

        const c = await drive(total, level, (i) => wide.manager.transaction((tx) => e.payments.recordOnAccountPayment(e.customerId, null, '1.00', 'bank_transfer', e.bankAccountId, `cap-${level}-${i}`, e.actor, tx)));
        paymentsOk += c.ok; summarize('payment.on-account(tx)', level, total, c);

        const d = await drive(total, level, (i) => e.inventory.reserveStock(e.warehouseId, hot, 1, `SO-cap-${level}-${i}`, e.actor, 'active', wide.manager));
        reservedOk += d.ok; summarize('inventory.reserveStock(hot product)', level, total, d);
      }
      // drain the outbox completely: one dispatch handles at most 50 events (batch size), the ladder created ~380 payment events
      let drained = 0;
      for (let i = 0; i < 100; i += 1) {
        const d = await e.events.dispatchAfterCommit(e.manager);
        drained += d.dispatched;
        if (d.dispatched === 0) break;
      }

      // invariants after the whole ladder
      const bankBal = Number(await e.treasury.getAccountBalance(e.bankAccountId, e.manager));
      const expectedBank = FUND - cashOutOk + paymentsOk; // each on-account payment cash-in is +1.00
      const payRows = (await e.dsA.query(`SELECT count(*)::int AS n FROM customer_payments WHERE reference LIKE 'cap-%'`))[0].n;
      const reservedRows = await reserved(e, e.warehouseId, hot);
      const auditRows = (await e.dsA.query(`SELECT count(*)::int AS n FROM audit_records WHERE action = 'capacity.probe'`))[0].n;
      const inv = { drainedEvents: drained, bankBal, expectedBank, payRows, paymentsOk, reservedRows, reservedOk, auditRows, auditOk, negativeStockPairs: await negativeStockPairs(e), onHandHot: await onHand(e, e.warehouseId, hot) };
      const invariantsOk = bankBal === expectedBank && payRows === paymentsOk && reservedRows === reservedOk && auditRows === auditOk && inv.negativeStockPairs === 0 && inv.onHandHot === 100000;
      const hardware = { cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, totalMemGB: Number((totalmem() / 2 ** 30).toFixed(1)), pgMaxConnections: maxConn, pool: 60, levels: LEVELS, note: 'local developer machine; node test process and PostgreSQL share the same CPU; fsync=off, autovacuum=off; not representative of hosting' };
      record(e, 'T-15-capacity-table.json', { hardware, table, invariants: inv });

      result(e, 'T-15-correctness-under-load', allClean && invariantsOk ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ allClean, invariantsOk, inv }));
      result(e, 'T-15-baseline-recorded', 'PASS', `capacity table written for ${LEVELS.join('/')} in-flight operations x 4 write paths; NO latency/throughput threshold applied (D-10 unapproved)`);

      await auditProbe(e, 'final');
      await reconcileAndRecord(e, { nonGlTreasury: FUND - cashOutOk, notes: [`${FUND}.00 funding cash-in and ${cashOutOk} x 1.00 cash-outs are deliberately non-emitting`] });
      await finishBiz(e);
      expect(e.results.filter((r) => r.status === 'FAIL' || r.status === 'STOP')).toEqual([]);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
