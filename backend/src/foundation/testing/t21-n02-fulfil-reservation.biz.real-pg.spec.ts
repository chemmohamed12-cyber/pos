import { randomUUID } from 'crypto';
import { BizEnv, abortBiz, attempt, finishBiz, negativeStockPairs, onHand, receive, record, reserved, result, seedProduct, seedWarehouse, setUpBiz, tally, widePool } from './biz-support';

/**
 * T-21 — N-02 `InventoryService.fulfillReservation` integrity (regression test for the reservation-fulfilment race; outside the frozen T-xx set).
 * Baseline defect (T-20 H3): N concurrent fulfilments of ONE reservation each read status 'active' (no lock) and each posted a dispatch movement — 6 movements for a
 * reservation of 3, on-hand −18 — even inside a transaction. Expected behaviour: a reservation is fulfilled exactly once; every other attempt is refused (409) and leaves no trace.
 * Cases: A) concurrent duplicate fulfilments (plain manager, as services/controllers pass it; and inside a transaction); B) sequential retries after success; C) partial failure
 * (the dispatch cannot be written) rolls back completely and the retry then succeeds exactly once; D) rollback of an OUTER transaction after a successful fulfilment;
 * E) concurrent order-level fulfilment (`fulfillReservationsForOrder`); F) positive control: different reservations fulfilled concurrently all succeed;
 * G) consistency: movements = fulfilled reservations, reserved quantity 0, on-hand = before − fulfilled quantity, one audit record per movement, no negative stock, audit chain valid.
 * Disposable databases `daii_test_biz_t21_*` only.
 */
describe('T-21 — a reservation is fulfilled exactly once (N-02 fulfillReservation)', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('duplicate, retried, partially failed and rolled-back fulfilments never create a second movement', async () => {
    try {
      env = await setUpBiz('T-21', 'biz_t21');
      const e = env;
      const W = e.warehouseId;
      const wide = await widePool(e, 30);
      const dispatches = async (p: string) => Number((await e.dsA.query(`SELECT count(*)::int AS n FROM stock_movements WHERE "productId" = $1 AND "movementType" = 'dispatch'`, [p]))[0].n);
      const status = async (id: string) => String((await e.dsA.query(`SELECT status FROM stock_reservations WHERE id = $1`, [id]))[0].status);
      const detail: Record<string, unknown> = {};
      // the audit hash chain is verified after EVERY case so that a break can be attributed to the operation that caused it
      const chain: Record<string, unknown> = {};
      const chainAfter = async (label: string) => { const v = await e.audit.verifyCompanyChain(e.manager); chain[label] = { valid: v.valid, brokenAtSeq: v.brokenAtSeq }; };

      // ---- A) concurrent duplicate fulfilment of ONE reservation, plain manager and transaction manager ----
      for (const style of ['plain', 'transaction'] as const) {
        const p = await seedProduct(e.dsA, `T21-A-${style}`);
        await receive(e, W, p, 50);
        const resv = await e.inventory.reserveStock(W, p, 3, randomUUID(), e.actor, 'active', e.manager);
        const before = await onHand(e, W, p);
        const outs = await Promise.all(Array.from({ length: 8 }, () => attempt(() => (style === 'plain'
          ? e.inventory.fulfillReservation(resv.id, e.actor, undefined, wide.manager)
          : wide.manager.transaction((tx) => e.inventory.fulfillReservation(resv.id, e.actor, undefined, tx))))));
        const ok = outs.filter((o) => o.ok).length;
        const t = tally(outs);
        const d = await dispatches(p);
        const after = await onHand(e, W, p);
        const st = await status(resv.id);
        const res = await reserved(e, W, p);
        detail[`A-${style}`] = { callsOk: ok, tally: t, dispatchMovements: d, onHandDelta: after - before, reservationStatus: st, reservedAfter: res };
        const good = ok === 1 && d === 1 && after === before - 3 && st === 'fulfilled' && res === 0 && (t['ConflictException:409'] ?? 0) === 7;
        result(e, `A-${style}-concurrent-duplicate-fulfilment`, good ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail[`A-${style}`]));
        await chainAfter(`after-A-${style}`);
      }

      // ---- B) sequential retries after a successful fulfilment ----
      {
        const p = await seedProduct(e.dsA, 'T21-B');
        await receive(e, W, p, 20);
        const resv = await e.inventory.reserveStock(W, p, 2, randomUUID(), e.actor, 'active', e.manager);
        const first = await attempt(() => e.inventory.fulfillReservation(resv.id, e.actor, undefined, e.manager));
        const retries = [] as Array<{ ok: boolean; kind: string }>;
        for (let i = 0; i < 3; i += 1) retries.push(await attempt(() => e.inventory.fulfillReservation(resv.id, e.actor, undefined, e.manager)));
        const d = await dispatches(p);
        const after = await onHand(e, W, p);
        detail.B = { first: first.ok, retries: retries.map((r) => r.kind), dispatchMovements: d, onHand: after };
        await chainAfter('after-B'); result(e, 'B-sequential-retries', first.ok && retries.every((r) => !r.ok && r.kind === 'ConflictException:409') && d === 1 && after === 18 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.B));
      }

      // ---- C) partial failure: the dispatch cannot be written (unknown warehouse override => foreign-key violation inside the unit) ----
      {
        const p = await seedProduct(e.dsA, 'T21-C');
        await receive(e, W, p, 20);
        const resv = await e.inventory.reserveStock(W, p, 4, randomUUID(), e.actor, 'active', e.manager);
        const before = await onHand(e, W, p);
        const auditBefore = Number((await e.dsA.query(`SELECT count(*)::int AS n FROM audit_records WHERE action LIKE 'inventory.movement.%'`))[0].n);
        const bad = await attempt(() => e.inventory.fulfillReservation(resv.id, e.actor, randomUUID(), wide.manager));
        const afterFail = { status: await status(resv.id), dispatchMovements: await dispatches(p), onHand: await onHand(e, W, p), audit: Number((await e.dsA.query(`SELECT count(*)::int AS n FROM audit_records WHERE action LIKE 'inventory.movement.%'`))[0].n) - auditBefore };
        const retry = await attempt(() => e.inventory.fulfillReservation(resv.id, e.actor, undefined, wide.manager));
        const afterRetry = { status: await status(resv.id), dispatchMovements: await dispatches(p), onHand: await onHand(e, W, p) };
        detail.C = { failedCall: bad, afterFail, retry: retry.ok, afterRetry };
        const good = !bad.ok && afterFail.status === 'active' && afterFail.dispatchMovements === 0 && afterFail.onHand === before && afterFail.audit === 0 && retry.ok && afterRetry.status === 'fulfilled' && afterRetry.dispatchMovements === 1 && afterRetry.onHand === before - 4;
        await chainAfter('after-C'); result(e, 'C-partial-failure-rolls-back-then-retry-once', good ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.C));
      }

      // ---- D) rollback of an OUTER transaction after a successful fulfilment ----
      {
        const p = await seedProduct(e.dsA, 'T21-D');
        await receive(e, W, p, 20);
        const resv = await e.inventory.reserveStock(W, p, 5, randomUUID(), e.actor, 'active', e.manager);
        const before = await onHand(e, W, p);
        const rolled = await attempt(() => wide.manager.transaction(async (tx) => { await e.inventory.fulfillReservation(resv.id, e.actor, undefined, tx); throw new Error('forced rollback'); }));
        const mid = { status: await status(resv.id), dispatchMovements: await dispatches(p), onHand: await onHand(e, W, p), reserved: await reserved(e, W, p) };
        const again = await attempt(() => e.inventory.fulfillReservation(resv.id, e.actor, undefined, wide.manager));
        const end = { status: await status(resv.id), dispatchMovements: await dispatches(p), onHand: await onHand(e, W, p) };
        detail.D = { rolledBack: !rolled.ok, mid, again: again.ok, end };
        const good = !rolled.ok && mid.status === 'active' && mid.dispatchMovements === 0 && mid.onHand === before && mid.reserved === 5 && again.ok && end.status === 'fulfilled' && end.dispatchMovements === 1 && end.onHand === before - 5;
        await chainAfter('after-D'); result(e, 'D-outer-transaction-rollback', good ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.D));
      }

      // ---- E) concurrent order-level fulfilment: ONE order with 3 reservations, 4 concurrent callers ----
      {
        const so = randomUUID();
        const ps = [await seedProduct(e.dsA, 'T21-E1'), await seedProduct(e.dsA, 'T21-E2'), await seedProduct(e.dsA, 'T21-E3')];
        for (const p of ps) await receive(e, W, p, 30);
        for (const p of ps) await e.inventory.reserveStock(W, p, 2, so, e.actor, 'active', e.manager);
        const before = await Promise.all(ps.map((p) => onHand(e, W, p)));
        const outs = await Promise.all(Array.from({ length: 4 }, () => attempt(() => e.inventory.fulfillReservationsForOrder(so, W, e.actor, wide.manager))));
        const movements = await Promise.all(ps.map((p) => dispatches(p)));
        const after = await Promise.all(ps.map((p) => onHand(e, W, p)));
        const stat = (await e.dsA.query(`SELECT status, count(*)::int AS n FROM stock_reservations WHERE "salesOrderId" = $1 GROUP BY 1`, [so]));
        detail.E = { tally: tally(outs), dispatchMovementsPerProduct: movements, onHandDelta: after.map((a, i) => a - before[i]), reservationStatuses: stat };
        const good = movements.every((m) => m === 1) && after.every((a, i) => a === before[i] - 2) && stat.length === 1 && stat[0].status === 'fulfilled' && stat[0].n === 3 && outs.filter((o) => o.ok).length >= 1;
        await chainAfter('after-E'); result(e, 'E-order-level-concurrent-fulfilment', good ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.E));
      }

      // ---- E2) order-level repeat is IDEMPOTENT (independent-review finding 3): once an order has no active reservation, fulfillReservationsForOrder is a successful no-op that writes nothing,
      // whereas fulfilling an already-fulfilled reservation DIRECTLY is refused with 409 (case B). Documented behaviour, asserted so that it cannot change silently. ----
      {
        const so = randomUUID();
        const p = await seedProduct(e.dsA, 'T21-E2-repeat');
        await receive(e, W, p, 20);
        await e.inventory.reserveStock(W, p, 2, so, e.actor, 'active', e.manager);
        const first = await attempt(() => e.inventory.fulfillReservationsForOrder(so, W, e.actor, e.manager));
        const afterFirst = { movements: await dispatches(p), onHand: await onHand(e, W, p) };
        const repeat = await attempt(() => e.inventory.fulfillReservationsForOrder(so, W, e.actor, e.manager));
        const afterRepeat = { movements: await dispatches(p), onHand: await onHand(e, W, p) };
        detail.E2 = { first: first.ok, repeat: repeat.ok, afterFirst, afterRepeat };
        result(e, 'E2-order-level-repeat-is-an-idempotent-noop', first.ok && repeat.ok && afterFirst.movements === 1 && afterRepeat.movements === 1 && afterRepeat.onHand === afterFirst.onHand ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.E2));
      }

      // ---- F) positive control: different reservations fulfilled concurrently all succeed ----
      {
        const ps: string[] = [];
        const ids: string[] = [];
        for (let i = 0; i < 6; i += 1) {
          const p = await seedProduct(e.dsA, `T21-F${i}`);
          await receive(e, W, p, 10);
          ps.push(p);
          ids.push((await e.inventory.reserveStock(W, p, 1, randomUUID(), e.actor, 'active', e.manager)).id);
        }
        const outs = await Promise.all(ids.map((id) => attempt(() => e.inventory.fulfillReservation(id, e.actor, undefined, wide.manager))));
        const movements = await Promise.all(ps.map((p) => dispatches(p)));
        detail.F = { tally: tally(outs), movements };
        result(e, 'F-different-reservations-all-succeed', outs.every((o) => o.ok) && movements.every((m) => m === 1) ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.F));
      }

      // ---- I) overlapping orders fulfilled concurrently in opposite line order must not deadlock (independent-review residual risk) ----
      {
        const rounds = 6;
        const stats = { rounds, bothOk: 0, errors: {} as Record<string, number> };
        const p1 = await seedProduct(e.dsA, 'T21-I1');
        const p2 = await seedProduct(e.dsA, 'T21-I2');
        await receive(e, W, p1, 200);
        await receive(e, W, p2, 200);
        const m0 = await dispatches(p1) + await dispatches(p2);
        for (let r = 0; r < rounds; r += 1) {
          const o1 = randomUUID(); const o2 = randomUUID();
          await e.inventory.reserveStock(W, p1, 1, o1, e.actor, 'active', e.manager);
          await e.inventory.reserveStock(W, p2, 1, o1, e.actor, 'active', e.manager);
          await e.inventory.reserveStock(W, p2, 1, o2, e.actor, 'active', e.manager); // opposite creation order
          await e.inventory.reserveStock(W, p1, 1, o2, e.actor, 'active', e.manager);
          const outs = await Promise.all([o1, o2, o1, o2].map((o) => attempt(() => e.inventory.fulfillReservationsForOrder(o, W, e.actor, wide.manager))));
          for (const o of outs.filter((x) => !x.ok)) stats.errors[(o as { pgCode?: string }).pgCode ?? o.kind] = (stats.errors[(o as { pgCode?: string }).pgCode ?? o.kind] ?? 0) + 1;
          if (outs.filter((x) => x.ok).length >= 2) stats.bothOk += 1;
        }
        const moved = (await dispatches(p1)) + (await dispatches(p2)) - m0;
        const deadlocks = stats.errors['40P01'] ?? 0;
        const unexpected = Object.entries(stats.errors).filter(([k]) => k !== 'ConflictException:409').reduce((a, [, v]) => a + v, 0);
        detail.I = { ...stats, dispatchMovements: moved, expectedMovements: rounds * 4, deadlocks, unexpectedErrors: unexpected };
        result(e, 'I-overlapping-orders-no-deadlock', deadlocks === 0 && unexpected === 0 && stats.bothOk === rounds && moved === rounds * 4 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.I));
      }

      // ---- J) override-warehouse case (second independent-review finding): the reservations sit in DIFFERENT warehouses (distinct reservation keys), but both orders are dispatched from the
      // SAME custody warehouse, so their valuation keys (override warehouse + product) overlap in opposite line order. ----
      {
        const rounds = 6;
        const wCustody = W;
        const wA = await seedWarehouse(e.dsA, 'T21J-A');
        const wB = await seedWarehouse(e.dsA, 'T21J-B');
        const pa = await seedProduct(e.dsA, 'T21-J1');
        const pb = await seedProduct(e.dsA, 'T21-J2');
        for (const wh of [wCustody, wA, wB]) { await receive(e, wh, pa, 200); await receive(e, wh, pb, 200); }
        const stats = { rounds, bothOk: 0, errors: {} as Record<string, number> };
        const countDispatch = async () => Number((await e.dsA.query('SELECT count(*)::int AS n FROM stock_movements WHERE "movementType" = \'dispatch\' AND "warehouseId" = $1', [wCustody]))[0].n);
        const before = await countDispatch();
        for (let r = 0; r < rounds; r += 1) {
          const o1 = randomUUID(); const o2 = randomUUID();
          await e.inventory.reserveStock(wA, pa, 1, o1, e.actor, 'active', e.manager);
          await e.inventory.reserveStock(wA, pb, 1, o1, e.actor, 'active', e.manager);
          await e.inventory.reserveStock(wB, pb, 1, o2, e.actor, 'active', e.manager); // opposite line order, other reservation warehouse
          await e.inventory.reserveStock(wB, pa, 1, o2, e.actor, 'active', e.manager);
          const outs = await Promise.all([o1, o2, o1, o2].map((o) => attempt(() => e.inventory.fulfillReservationsForOrder(o, wCustody, e.actor, wide.manager))));
          for (const o of outs.filter((x) => !x.ok)) { const k = (o as { pgCode?: string }).pgCode ?? o.kind; stats.errors[k] = (stats.errors[k] ?? 0) + 1; }
          if (outs.filter((x) => x.ok).length >= 2) stats.bothOk += 1;
        }
        const moved = (await countDispatch()) - before;
        const deadlocks = stats.errors['40P01'] ?? 0;
        const unexpected = Object.entries(stats.errors).filter(([k]) => k !== 'ConflictException:409').reduce((a, [, v]) => a + v, 0);
        detail.J = { ...stats, dispatchMovementsAtCustodyWarehouse: moved, expectedMovements: rounds * 4, deadlocks, unexpectedErrors: unexpected };
        result(e, 'J-override-warehouse-overlapping-orders-no-deadlock', deadlocks === 0 && unexpected === 0 && stats.bothOk === rounds && moved === rounds * 4 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.J));
      }

      // ---- G) global consistency ----
      {
        const fulfilled = Number((await e.dsA.query(`SELECT count(*)::int AS n FROM stock_reservations WHERE status = 'fulfilled'`))[0].n);
        const disp = Number((await e.dsA.query(`SELECT count(*)::int AS n FROM stock_movements WHERE "movementType" = 'dispatch'`))[0].n);
        const auditRows = Number((await e.dsA.query(`SELECT count(*)::int AS n FROM audit_records WHERE action = 'inventory.movement.dispatch'`))[0].n);
        const active = Number((await e.dsA.query(`SELECT count(*)::int AS n FROM stock_reservations WHERE status = 'active'`))[0].n);
        const neg = await negativeStockPairs(e);
        detail.G = { fulfilledReservations: fulfilled, dispatchMovements: disp, dispatchAuditRecords: auditRows, activeReservationsLeft: active, negativeStockPairs: neg };
        result(e, 'G-global-consistency', fulfilled === disp && auditRows === disp && active === 0 && neg === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.G));
      }

      record(e, 'T-21-detail.json', detail);
      record(e, 'T-21-chain-after-each-case.json', chain);
      // The audit hash chain was verified after every case. Cases A-C (concurrency, retries, partial failure) must leave it valid. Case D deliberately rolls back an OUTER transaction that
      // contained an audit write: that exposes F-AUD-003 (rolled-back audit insert burns the DB sequence value that the hash was computed with; see f-aud-rollback-reproducer, T-22) — a
      // separate, pre-existing AuditService defect that is NOT part of N-02. It is reported as its own case, never hidden and never counted against the fulfilment assertions.
      const cv = chain as Record<string, { valid: boolean; brokenAtSeq: number | null }>;
      result(e, 'H-audit-chain-valid-after-A-B-C', cv['after-A-plain'].valid && cv['after-A-transaction'].valid && cv['after-B'].valid && cv['after-C'].valid ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ afterA: cv['after-A-plain'], afterATx: cv['after-A-transaction'], afterB: cv['after-B'], afterC: cv['after-C'] }));
      result(e, 'H-audit-chain-after-D-rollback (F-AUD-003, not N-02)', cv['after-D'].valid ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ afterD: cv['after-D'], afterE: cv['after-E'] }));
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
