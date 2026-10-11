import { randomUUID } from 'crypto';
import { LimitService } from '../limit-engine/limit.service';
import { LimitProfile } from '../limit-engine/limit-profile.entity';
import { ProcessDefinition } from '../process-engine/process-definition';
import { BizEnv, abortBiz, attempt, finishBiz, onHand, receive, record, reserved, result, seedProduct, setUpBiz, tally, widePool } from './biz-support';

/**
 * T-24 — N-02 remaining findings: targeted concurrency / rollback / retry / integrity tests for the three remediated primitives (outside the frozen T-xx set).
 *  H1 LimitService.consume / release     (baseline T-20 H1-A: 13 allowed against a cap of 10)
 *  H2 InventoryService.releaseReservedQuantity (baseline T-20 H2-A: 11 of 12 releases succeeded for 5 reserved units)
 *  H4 ProcessEngineService.start         (baseline T-20 H4: a database error on racing starts, in both calling styles)
 * H5 (shipment transition) remains BLOCKED / NOT RUN: it needs a full shipment fixture. Disposable databases `daii_test_biz_t24_*` only.
 */
describe('T-24 — limit engine, reservation release and process start are race-free (N-02 remaining findings)', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => { if (env) await abortBiz(env, failure); });

  it('H1, H2, H4: concurrency, rollback, retries, integrity', async () => {
    try {
      env = await setUpBiz('T-24', 'biz_t24');
      const e = env;
      const wide = await widePool(e, 40);
      const W = e.warehouseId;
      const detail: Record<string, unknown> = {};
      const limits = new LimitService(e.h.controlPlane, { sync: async () => undefined } as never, e.audit);
      const counter = async (key: string) => Number((await e.dsA.query(`SELECT "currentValue" FROM limit_usage_counters WHERE "limitKey" = $1`, [key]))[0]?.currentValue ?? 0);
      const profile = async (key: string, max: number) => { await e.dsA.getRepository(LimitProfile).save(e.dsA.getRepository(LimitProfile).create({ limitKey: key, moduleCode: 'sales', unit: 'count', maxValue: max })); };

      // ================= H1 limit engine =================
      for (const style of ['plain', 'transaction'] as const) {
        const key = `t24.cap.${style}`;
        await profile(key, 10);
        const outs = await Promise.all(Array.from({ length: 40 }, () => (style === 'plain' ? limits.consume(key, 1, wide.manager) : wide.manager.transaction((tx) => limits.consume(key, 1, tx))).then((r) => r.allowed, () => 'error')));
        const allowed = outs.filter((x) => x === true).length;
        const errors = outs.filter((x) => x === 'error').length;
        const c = await counter(key);
        // retries after the cap is reached are refused and change nothing
        const again = await limits.consume(key, 1, wide.manager);
        detail[`H1-${style}`] = { cap: 10, allowed, errors, counter: c, retryAllowed: again.allowed, counterAfterRetry: await counter(key) };
        result(e, `H1-${style}-concurrent-consume-respects-cap`, allowed === 10 && errors === 0 && c === 10 && !again.allowed && (await counter(key)) === 10 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail[`H1-${style}`]));
      }
      {
        const key = 't24.rollback';
        await profile(key, 10);
        const out = await attempt(() => wide.manager.transaction(async (tx) => { await limits.consume(key, 3, tx); throw new Error('forced rollback'); }));
        const afterRollback = await counter(key);
        const ok = await limits.consume(key, 3, wide.manager);
        detail['H1-rollback'] = { rolledBack: !out.ok, counterAfterRollback: afterRollback, consumeAfterRollbackAllowed: ok.allowed, counterEnd: await counter(key) };
        result(e, 'H1-outer-rollback-restores-quota', !out.ok && afterRollback === 0 && ok.allowed && (await counter(key)) === 3 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['H1-rollback']));
      }
      {
        const key = 't24.release';
        await profile(key, 10);
        await limits.consume(key, 5, wide.manager);
        await Promise.all(Array.from({ length: 12 }, () => attempt(() => limits.release(key, 1, wide.manager))));
        const end = await counter(key);
        detail['H1-release'] = { consumed: 5, releases: 12, counterEnd: end };
        result(e, 'H1-concurrent-release-floors-at-zero', end === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['H1-release']));
      }

      // ================= H2 releaseReservedQuantity =================
      for (const style of ['plain', 'transaction'] as const) {
        const P = await seedProduct(e.dsA, `T24-H2-${style}`);
        await receive(e, W, P, 50);
        const so = randomUUID();
        await e.inventory.reserveStock(W, P, 5, so, e.actor, 'active', e.manager);
        const before = await onHand(e, W, P);
        const outs = await Promise.all(Array.from({ length: 12 }, () => attempt(() => (style === 'plain'
          ? e.inventory.releaseReservedQuantity(so, P, W, 1, e.actor, wide.manager)
          : wide.manager.transaction((tx) => e.inventory.releaseReservedQuantity(so, P, W, 1, e.actor, tx))))));
        const ok = outs.filter((o) => o.ok).length;
        const t = tally(outs);
        const active = Number((await e.dsA.query(`SELECT coalesce(sum(quantity),0)::int AS q FROM stock_reservations WHERE "salesOrderId" = $1 AND status = 'active'`, [so]))[0].q);
        const retry = await attempt(() => e.inventory.releaseReservedQuantity(so, P, W, 1, e.actor, wide.manager));
        detail[`H2-${style}`] = { reserved: 5, callsOk: ok, tally: t, stillActive: active, reservedAfter: await reserved(e, W, P), onHandDelta: (await onHand(e, W, P)) - before, retryRefused: !retry.ok && retry.kind === 'ConflictException:409' };
        result(e, `H2-${style}-concurrent-release-never-exceeds-reserved`, ok === 5 && active === 0 && (t['ConflictException:409'] ?? 0) === 7 && (await reserved(e, W, P)) === 0 && (await onHand(e, W, P)) === before && !retry.ok && retry.kind === 'ConflictException:409' ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail[`H2-${style}`]));
      }
      {
        const P = await seedProduct(e.dsA, 'T24-H2-rollback');
        await receive(e, W, P, 50);
        const so = randomUUID();
        await e.inventory.reserveStock(W, P, 5, so, e.actor, 'active', e.manager);
        const out = await attempt(() => wide.manager.transaction(async (tx) => { await e.inventory.releaseReservedQuantity(so, P, W, 3, e.actor, tx); throw new Error('forced rollback'); }));
        const mid = await reserved(e, W, P);
        const again = await attempt(() => e.inventory.releaseReservedQuantity(so, P, W, 3, e.actor, wide.manager));
        detail['H2-rollback'] = { rolledBack: !out.ok, reservedAfterRollback: mid, retryOk: again.ok, reservedEnd: await reserved(e, W, P) };
        result(e, 'H2-outer-rollback-restores-reservation', !out.ok && mid === 5 && again.ok && (await reserved(e, W, P)) === 2 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['H2-rollback']));
      }

      // ================= H4 process start =================
      const def: ProcessDefinition = { key: 't24_start', initialState: 'a', transitions: [{ from: 'a', to: 'b', action: 'go' }] };
      for (const style of ['plain', 'transaction'] as const) {
        const id = randomUUID();
        const settled = await Promise.allSettled(Array.from({ length: 10 }, () => (style === 'plain' ? e.processEngine.start(def, 'probe', id, wide.manager) : wide.manager.transaction((tx) => e.processEngine.start(def, 'probe', id, tx)))));
        const okRes = settled.filter((s) => s.status === 'fulfilled') as PromiseFulfilledResult<{ id: string; currentState: string }>[];
        const ids = new Set(okRes.map((s) => s.value.id));
        const rows = Number((await e.dsA.query(`SELECT count(*)::int AS n FROM process_instances WHERE "definitionKey" = 't24_start' AND "entityId" = $1`, [id]))[0].n);
        detail[`H4-${style}`] = { fulfilled: okRes.length, rejected: settled.length - okRes.length, distinctInstanceIds: ids.size, rows, state: okRes[0]?.value.currentState };
        result(e, `H4-${style}-concurrent-start-single-instance-no-error`, okRes.length === 10 && ids.size === 1 && rows === 1 && okRes[0].value.currentState === 'a' ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail[`H4-${style}`]));
      }
      {
        const id = randomUUID();
        const out = await attempt(() => wide.manager.transaction(async (tx) => { await e.processEngine.start(def, 'probe', id, tx); throw new Error('forced rollback'); }));
        const rowsMid = Number((await e.dsA.query(`SELECT count(*)::int AS n FROM process_instances WHERE "definitionKey" = 't24_start' AND "entityId" = $1`, [id]))[0].n);
        const first = await e.processEngine.start(def, 'probe', id, wide.manager);
        const second = await e.processEngine.start(def, 'probe', id, wide.manager);
        detail['H4-rollback-retry'] = { rolledBack: !out.ok, rowsAfterRollback: rowsMid, firstId: first.id, secondSameId: second.id === first.id };
        result(e, 'H4-rollback-then-retry-idempotent', !out.ok && rowsMid === 0 && second.id === first.id ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['H4-rollback-retry']));
      }

      result(e, 'H5-shipment-transition', 'BLOCKED', 'NOT RUN: needs a full shipment fixture; never counted as a pass (unchanged from T-20)');
      record(e, 'T-24-detail.json', detail);
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
