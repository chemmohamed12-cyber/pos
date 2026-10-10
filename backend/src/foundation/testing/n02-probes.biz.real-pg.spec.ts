import { randomUUID } from 'crypto';
import { LimitService } from '../limit-engine/limit.service';
import { LimitProfile } from '../limit-engine/limit-profile.entity';
import { ProcessDefinition } from '../process-engine/process-definition';
import { BizEnv, abortBiz, attempt, finishBiz, onHand, receive, record, result, seedProduct, setUpBiz, tally, widePool } from './biz-support';

/**
 * N-02 DIAGNOSTIC PROBES (D-06, 2026-10-11) — informational, OUTSIDE the frozen T-xx set, separate from N-01. NO product code is changed; disposable databases `daii_test_biz_t20_*` only.
 * Context: N-01 showed that primitives written as `manager ? run(manager) : dataSource.transaction(run)` lose their lock when a controller passes a plain manager. The same idiom remains in
 * other primitives. Each probe states a HYPOTHESIS, a setup, a reproduction, the expected (safe) result and records the actual result for two calling styles:
 *   A) plain manager (what controllers pass: `req.companyContext.dataSource.manager`)      B) the same call inside `manager.transaction`.
 * PASS = the guarantee held; FAIL-DEFECT = the guarantee was violated (a candidate defect, to be judged by the CTO — not a harness error).
 *
 *  H1  LimitService.consume(key, 1, manager): a cap of 10 is never exceeded under 40 concurrent consumers.
 *  H2  InventoryService.releaseReservedQuantity: releasing 1 unit x 12 concurrently against 5 reserved releases exactly 5 units (never more than reserved).
 *  H3  InventoryService.fulfillReservation: 6 concurrent fulfilments of ONE reservation produce exactly one dispatch movement.
 *  H4  ProcessEngineService.start: 10 concurrent starts of the SAME entity leave exactly one process instance and raise no database error.
 *  H5  ShipmentService.transitionShipment: NOT RUN (needs a full shipment fixture: order, invoice, custody, couriers) — recorded as not executed, never as pass.
 *  H6  MovingAverageCostEngine under plain manager: not probed here — covered by T-01/T-03 (concurrent issues and receipts with the plain wide manager, valuation reconciled by R2): PASS in those runs.
 */
describe('N-02 probes — plain-manager hypotheses for the remaining primitives', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => { if (env) await abortBiz(env, failure); });

  it('records the observed behaviour of both calling styles for H1-H4', async () => {
    try {
      env = await setUpBiz('T-20', 'biz_t20');
      const e = env;
      const wide = await widePool(e, 40);
      const W = e.warehouseId;
      const detail: Record<string, unknown> = {};

      // ---------------- H1 limit engine ----------------
      const limits = new LimitService(e.h.controlPlane, { sync: async () => undefined } as never, e.audit);
      for (const style of ['plain', 'transaction'] as const) {
        const key = `probe.cap.${style}`;
        await e.dsA.getRepository(LimitProfile).save(e.dsA.getRepository(LimitProfile).create({ limitKey: key, moduleCode: 'sales', unit: 'count', maxValue: 10 }));
        const outs = await Promise.all(Array.from({ length: 40 }, () => (style === 'plain'
          ? limits.consume(key, 1, wide.manager)
          : wide.manager.transaction((tx) => limits.consume(key, 1, tx))).then((r) => r.allowed, () => 'error')));
        const allowed = outs.filter((x) => x === true).length; const errors = outs.filter((x) => x === 'error').length;
        const counter = (await e.dsA.query(`SELECT "currentValue" FROM limit_usage_counters WHERE "limitKey" = $1`, [key]))[0]?.currentValue;
        detail[`H1-${style}`] = { cap: 10, allowed, errors, counter };
        result(e, `H1-${style === 'plain' ? 'A-plain-manager' : 'B-transaction-manager'}`, allowed === 10 && Number(counter) === 10 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ cap: 10, allowed, errors, counter }));
      }

      // ---------------- H2 releaseReservedQuantity ----------------
      for (const style of ['plain', 'transaction'] as const) {
        const P = await seedProduct(e.dsA, `N02-H2-${style}`);
        await receive(e, W, P, 50);
        const so = randomUUID();
        await e.inventory.reserveStock(W, P, 5, so, e.actor, 'active', e.manager);
        const outs = await Promise.all(Array.from({ length: 12 }, () => attempt(() => (style === 'plain'
          ? e.inventory.releaseReservedQuantity(so, P, W, 1, e.actor, wide.manager)
          : wide.manager.transaction((tx) => e.inventory.releaseReservedQuantity(so, P, W, 1, e.actor, tx))))));
        const ok = outs.filter((o) => o.ok).length;
        const rows = await e.dsA.query(`SELECT coalesce(sum(quantity),0)::int AS active FROM stock_reservations WHERE "salesOrderId" = $1 AND status = 'active'`, [so]);
        detail[`H2-${style}`] = { reserved: 5, releaseCallsOk: ok, stillActive: rows[0].active, tally: tally(outs) };
        result(e, `H2-${style === 'plain' ? 'A-plain-manager' : 'B-transaction-manager'}`, ok === 5 && rows[0].active === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ reserved: 5, releaseCallsOk: ok, stillActive: rows[0].active }));
      }

      // ---------------- H3 fulfillReservation ----------------
      for (const style of ['plain', 'transaction'] as const) {
        const P = await seedProduct(e.dsA, `N02-H3-${style}`);
        await receive(e, W, P, 50);
        const so = randomUUID();
        const resv = await e.inventory.reserveStock(W, P, 3, so, e.actor, 'active', e.manager);
        const before = await onHand(e, W, P);
        const outs = await Promise.all(Array.from({ length: 6 }, () => attempt(() => (style === 'plain'
          ? e.inventory.fulfillReservation(resv.id, e.actor, undefined, wide.manager)
          : wide.manager.transaction((tx) => e.inventory.fulfillReservation(resv.id, e.actor, undefined, tx))))));
        const ok = outs.filter((o) => o.ok).length;
        const dispatches = (await e.dsA.query(`SELECT count(*)::int AS n FROM stock_movements WHERE "productId" = $1 AND "movementType" = 'dispatch'`, [P]))[0].n;
        const after = await onHand(e, W, P);
        detail[`H3-${style}`] = { reservedQty: 3, fulfilCallsOk: ok, dispatchMovements: dispatches, onHandBefore: before, onHandAfter: after, tally: tally(outs) };
        result(e, `H3-${style === 'plain' ? 'A-plain-manager' : 'B-transaction-manager'}`, ok === 1 && dispatches === 1 && after === before - 3 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ fulfilCallsOk: ok, dispatchMovements: dispatches, onHandDelta: after - before }));
      }

      // ---------------- H4 process engine start ----------------
      const def: ProcessDefinition = { key: 'n02_start', initialState: 'a', transitions: [{ from: 'a', to: 'b', action: 'go' }] };
      for (const style of ['plain', 'transaction'] as const) {
        const id = randomUUID();
        const outs = await Promise.all(Array.from({ length: 10 }, () => attempt(() => (style === 'plain'
          ? e.processEngine.start(def, 'probe', id, wide.manager)
          : wide.manager.transaction((tx) => e.processEngine.start(def, 'probe', id, tx))))));
        const rows = (await e.dsA.query(`SELECT count(*)::int AS n FROM process_instances WHERE "definitionKey" = 'n02_start' AND "entityId" = $1`, [id]))[0].n;
        const errs = outs.filter((o) => !o.ok).length;
        detail[`H4-${style}`] = { instances: rows, errors: errs, tally: tally(outs) };
        result(e, `H4-${style === 'plain' ? 'A-plain-manager' : 'B-transaction-manager'}`, rows === 1 && errs === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ instances: rows, errors: errs, tally: tally(outs) }));
      }

      result(e, 'H5-shipment-transition', 'BLOCKED', 'NOT RUN: needs a full shipment fixture (order, invoice, custody, couriers); no probe was written — never counted as a pass');
      record(e, 'N-02-probe-detail.json', detail);
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
