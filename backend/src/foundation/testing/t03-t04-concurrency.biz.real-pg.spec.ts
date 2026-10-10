import { randomUUID } from 'crypto';
import { WAREHOUSE_TRANSACTION_PROCESS } from '../../domains/inventory-warehouse/domain/warehouse-transaction-process';
import { BizEnv, abortBiz, approvedDoc, attempt, auditChainValid, finishBiz, negativeStockPairs, onHand, receive, record, reserved, result, seedProduct, setUpBiz, tally, widePool } from './biz-support';
import { reconcileAndRecord } from './biz-reconcile';

/**
 * T-03 (reservation concurrency), T-04 (issue-posting concurrency) and T-04b (mixed) — FROZEN in
 * docs/decisions/test-program/T-PLAN-FROZEN-2026-10-10.md. Disposable databases `daii_test_biz_t03_*` only.
 * Every round is recorded; any deviation in any round is STOP (no averaging). The effective concurrency is min(N, pool size);
 * the pool is widened to 60 so N=10/25/50 run on N separate connections.
 */
describe('T-03 / T-04 — concurrent reservations and issue postings never exceed the available stock', () => {
  jest.setTimeout(1_800_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('T-03 + T-04 + T-04b', async () => {
    try {
      env = await setUpBiz('T-03', 'biz_t03');
      const e = env;
      const W = e.warehouseId;
      const wide = await widePool(e, 60);
      const M = wide.manager;
      let stop = false;

      // ===================== T-03: N concurrent reservations of 1 unit from on-hand 5 =====================
      const t03: Record<string, unknown[]> = {};
      for (const N of [10, 25, 50]) {
        t03[`N${N}`] = [];
        for (let round = 1; round <= 20 && !stop; round += 1) {
          const P = await seedProduct(e.dsA, `T03-N${N}-R${round}`);
          await receive(e, W, P, 5);
          const outs = await Promise.all(Array.from({ length: N }, () => attempt(() => e.inventory.reserveStock(W, P, 1, `SO-${randomUUID()}`, e.actor, 'active', M))));
          const t = tally(outs);
          const moves = (await e.dsA.query(`SELECT count(*)::int AS n FROM stock_movements WHERE "productId" = $1`, [P]))[0].n;
          const activeRows = (await e.dsA.query(`SELECT count(*)::int AS n, coalesce(sum(quantity),0)::int AS q FROM stock_reservations WHERE "productId" = $1 AND status IN ('active','preliminary')`, [P]))[0];
          const state = { round, N, tally: t, movements: moves, activeReservations: activeRows.n, reservedQty: activeRows.q, onHand: await onHand(e, W, P), available: await e.inventory.getAvailable(W, P, e.manager) };
          (t03[`N${N}`] as unknown[]).push(state);
          const ok = t.OK === 5 && t['ConflictException:409'] === N - 5 && Object.keys(t).length === 2 && moves === 1 && activeRows.q === 5 && state.onHand === 5 && state.available === 0;
          if (!ok) { stop = true; result(e, `T-03-N${N}-R${round}`, 'STOP', JSON.stringify(state)); }
        }
        if (!stop) result(e, `T-03-N${N}`, 'PASS', '20 rounds: exactly 5 reserved, the rest refused with 409, no other error kind, available = 0, movements unchanged');
        record(e, `T-03-N${N}-rounds.json`, t03[`N${N}`]);
      }

      // ===================== T-04: N concurrent postings of 1-unit issue documents from on-hand 5 =====================
      const t04: Record<string, unknown[]> = {};
      for (const N of [10, 25]) {
        t04[`N${N}`] = [];
        for (let round = 1; round <= 20 && !stop; round += 1) {
          const P = await seedProduct(e.dsA, `T04-N${N}-R${round}`);
          await receive(e, W, P, 5);
          const docs: string[] = [];
          for (let i = 0; i < N; i += 1) docs.push(await approvedDoc(e, 'issue', W, [{ productId: P, quantity: 1 }]));
          const outs = await Promise.all(docs.map((id) => attempt(() => e.whTx.transition(id, 'post', e.actor, M))));
          const t = tally(outs);
          const sum = (await e.dsA.query(`SELECT coalesce(sum(quantity),0)::int AS s FROM stock_movements WHERE "productId" = $1`, [P]))[0].s;
          const dispatches = (await e.dsA.query(`SELECT count(*)::int AS n FROM stock_movements WHERE "productId" = $1 AND "movementType" = 'dispatch'`, [P]))[0].n;
          let halfPosted = 0;
          let posted = 0;
          for (const id of docs) {
            const state = await e.processEngine.getState(WAREHOUSE_TRANSACTION_PROCESS, 'warehouse_transaction', id, e.manager);
            const mv = (await e.dsA.query(`SELECT count(*)::int AS n FROM stock_movements WHERE "referenceType" = 'warehouse_transaction' AND "referenceId" = $1`, [id]))[0].n;
            if (state === 'posted') { posted += 1; if (mv !== 1) halfPosted += 1; } else if (mv !== 0) halfPosted += 1;
          }
          const st = { round, N, tally: t, sumQuantity: sum, dispatches, posted, halfPosted };
          (t04[`N${N}`] as unknown[]).push(st);
          const ok = t.OK === 5 && t['ConflictException:409'] === N - 5 && Object.keys(t).length === 2 && sum === 0 && dispatches === 5 && posted === 5 && halfPosted === 0;
          if (!ok) { stop = true; result(e, `T-04-N${N}-R${round}`, 'STOP', JSON.stringify(st)); }
        }
        if (!stop) result(e, `T-04-N${N}`, 'PASS', '20 rounds: exactly 5 posted, the rest refused with 409, SUM(quantity)=0, 5 dispatch movements, no half-posted document');
        record(e, `T-04-N${N}-rounds.json`, t04[`N${N}`]);
      }

      // ===================== T-04b: 5 reservations + 5 issue postings compete for 5 units =====================
      const t04b: unknown[] = [];
      for (let round = 1; round <= 20 && !stop; round += 1) {
        const P = await seedProduct(e.dsA, `T04B-R${round}`);
        await receive(e, W, P, 5);
        const docs: string[] = [];
        for (let i = 0; i < 5; i += 1) docs.push(await approvedDoc(e, 'issue', W, [{ productId: P, quantity: 1 }]));
        const jobs = [
          ...Array.from({ length: 5 }, () => ({ kind: 'reserve', run: () => attempt(() => e.inventory.reserveStock(W, P, 1, `SO-${randomUUID()}`, e.actor, 'active', M)) })),
          ...docs.map((id) => ({ kind: 'post', run: () => attempt(() => e.whTx.transition(id, 'post', e.actor, M)) })),
        ];
        const outs = await Promise.all(jobs.map((j) => j.run()));
        const okReserve = outs.filter((o, i) => jobs[i].kind === 'reserve' && o.ok).length;
        const okPost = outs.filter((o, i) => jobs[i].kind === 'post' && o.ok).length;
        const other = outs.filter((o) => !o.ok && o.kind !== 'ConflictException:409').length;
        const oh = await onHand(e, W, P);
        const rs = await reserved(e, W, P);
        const st = { round, okReserve, okPost, other, onHand: oh, reserved: rs, available: oh - rs };
        t04b.push(st);
        const ok = okReserve + okPost === 5 && other === 0 && oh === 5 - okPost && oh >= 0 && oh - rs >= 0;
        if (!ok) { stop = true; result(e, `T-04b-R${round}`, 'STOP', JSON.stringify(st)); }
      }
      if (!stop) result(e, 'T-04b', 'PASS', '20 rounds: successes = 5 exactly, on-hand >= 0, available >= 0, no other error kind');
      record(e, 'T-04b-rounds.json', t04b);

      // ===================== global invariants =====================
      const neg = await negativeStockPairs(e);
      result(e, 'invariant-no-negative-stock', neg === 0 ? 'PASS' : 'STOP', `pairs with negative on-hand: ${neg}`);
      const chain = await auditChainValid(e);
      result(e, 'invariant-audit-chain-valid', chain ? 'PASS' : 'STOP');

      await reconcileAndRecord(e, {});
      await finishBiz(e);
      expect(e.results.filter((r) => r.status === 'FAIL' || r.status === 'STOP')).toEqual([]);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
