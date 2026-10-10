import { randomUUID } from 'crypto';
import { BizEnv, abortBiz, approvedDoc, attempt, auditChainValid, finishBiz, fp, fpDiff, negativeStockPairs, onHand, receive, record, reserved, result, seedProduct, seedWarehouse, setUpBiz } from './biz-support';
import { reconcileAndRecord } from './biz-reconcile';

/**
 * T-01 (REQ-INV-002) and T-02 (REQ-INV-002/005) — FROZEN in docs/decisions/test-program/T-PLAN-FROZEN-2026-10-10.md.
 * Business-test program: runs ONLY against fresh disposable databases `daii_test_biz_t01_*` on the approved instance.
 */
describe('T-01 / T-02 — over-issue, over-transfer and over-reservation are refused with no partial effect', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;

  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('T-01 + T-02', async () => {
    try {
      env = await setUpBiz('T-01', 'biz_t01');
      const e = env;
      const W1 = e.warehouseId;
      const W2 = await seedWarehouse(e.dsA, 'A2');
      const P1 = await seedProduct(e.dsA, 'T01-P1');
      const P2 = await seedProduct(e.dsA, 'T01-P2');
      await receive(e, W1, P1, 5);
      await receive(e, W1, P2, 5);
      expect(await onHand(e, W1, P1)).toBe(5);

      // ---------- T-01(a): issue P1 qty 6 ----------
      const docA = await approvedDoc(e, 'issue', W1, [{ productId: P1, quantity: 6 }]);
      const beforeA = await fp(e);
      const auditBeforeA = (await e.dsA.query('SELECT count(*)::int AS n FROM audit_records'))[0].n;
      const outA = await attempt(() => e.whTx.transition(docA, 'post', e.actor, e.manager));
      const afterA = await fp(e);
      record(e, 'T-01a.json', { outcome: outA, fingerprintDiff: fpDiff(beforeA, afterA), onHandP1: await onHand(e, W1, P1) });
      const okA = !outA.ok && outA.kind.endsWith(':409') && /Insufficient stock/.test(outA.message ?? '') && fpDiff(beforeA, afterA).length === 0 && (await onHand(e, W1, P1)) === 5;
      const auditAfterA = (await e.dsA.query('SELECT count(*)::int AS n FROM audit_records'))[0].n;
      result(e, 'T-01a', okA && auditAfterA === auditBeforeA && (await auditChainValid(e)) ? 'PASS' : 'FAIL', JSON.stringify({ outA, auditBeforeA, auditAfterA }));

      // ---------- T-01(b): two lines, P1 qty 3 (sufficient) + P2 qty 9 (short) => whole document refused ----------
      const docB = await approvedDoc(e, 'issue', W1, [{ productId: P1, quantity: 3 }, { productId: P2, quantity: 9 }]);
      const beforeB = await fp(e);
      const outB = await attempt(() => e.whTx.transition(docB, 'post', e.actor, e.manager));
      const afterB = await fp(e);
      const okB = !outB.ok && outB.kind.endsWith(':409') && fpDiff(beforeB, afterB).length === 0 && (await onHand(e, W1, P1)) === 5 && (await onHand(e, W1, P2)) === 5;
      record(e, 'T-01b.json', { outcome: outB, fingerprintDiff: fpDiff(beforeB, afterB) });
      result(e, 'T-01b', okB ? 'PASS' : 'FAIL', JSON.stringify(outB));

      // ---------- T-01(c): control — issue P1 qty 5 posts ----------
      const docC = await approvedDoc(e, 'issue', W1, [{ productId: P1, quantity: 5 }]);
      const outC = await attempt(() => e.whTx.transition(docC, 'post', e.actor, e.manager));
      const dispatches = (await e.dsA.query(`SELECT count(*)::int AS n FROM stock_movements WHERE "productId" = $1 AND "movementType" = 'dispatch'`, [P1]))[0].n;
      result(e, 'T-01c', outC.ok && (await onHand(e, W1, P1)) === 0 && dispatches === 1 ? 'PASS' : 'FAIL', JSON.stringify({ outC, dispatches }));

      // ---------- T-02(a): transfer W1 -> W2 qty 6 with on-hand 5 (P2) ----------
      const docT = await approvedDoc(e, 'transfer', W1, [{ productId: P2, quantity: 6 }], W2);
      const beforeT = await fp(e);
      const outT = await attempt(() => e.whTx.transition(docT, 'post', e.actor, e.manager));
      const afterT = await fp(e);
      const okT = !outT.ok && outT.kind.endsWith(':409') && fpDiff(beforeT, afterT).length === 0 && (await onHand(e, W1, P2)) === 5 && (await onHand(e, W2, P2)) === 0;
      record(e, 'T-02a.json', { outcome: outT, fingerprintDiff: fpDiff(beforeT, afterT) });
      result(e, 'T-02a', okT ? 'PASS' : 'FAIL', JSON.stringify(outT));

      // ---------- T-02(b): direct reservation qty 6 ----------
      const beforeR = await fp(e);
      const outR = await attempt(() => e.inventory.reserveStock(W1, P2, 6, `SO-${randomUUID()}`, e.actor, 'active', e.manager));
      const afterR = await fp(e);
      const okR = !outR.ok && outR.kind.endsWith(':409') && fpDiff(beforeR, afterR).length === 0;
      record(e, 'T-02b.json', { outcome: outR, fingerprintDiff: fpDiff(beforeR, afterR) });
      result(e, 'T-02b', okR ? 'PASS' : 'FAIL', JSON.stringify(outR));

      // ---------- T-02(c): reserve 3 then reserve 3 (second must be refused) ----------
      const r1 = await attempt(() => e.inventory.reserveStock(W1, P2, 3, `SO-${randomUUID()}`, e.actor, 'active', e.manager));
      const r2 = await attempt(() => e.inventory.reserveStock(W1, P2, 3, `SO-${randomUUID()}`, e.actor, 'active', e.manager));
      const okC2 = r1.ok && !r2.ok && r2.kind.endsWith(':409') && (await reserved(e, W1, P2)) === 3 && (await e.inventory.getAvailable(W1, P2, e.manager)) === 2;
      result(e, 'T-02c', okC2 ? 'PASS' : 'FAIL', JSON.stringify({ r1, r2 }));

      // ---------- T-02(d): assemble with a missing component ----------
      result(e, 'T-02d', 'BLOCKED', 'the BOM contract is not wired in the two-company harness (InventoryService.assembleProduct needs SALES_BOM_CONTRACT); the over-consumption guard of component issue is exercised through Work Orders (work-order.spec) — recorded as not executed here, per the frozen plan\'s conditional "(if BOM is available in the tags)"');

      // ---------- global invariants ----------
      expect(await negativeStockPairs(e)).toBe(0);
      expect(await auditChainValid(e)).toBe(true);
      result(e, 'invariant-no-negative-stock', (await negativeStockPairs(e)) === 0 ? 'PASS' : 'STOP');

      await reconcileAndRecord(e, {});
      await finishBiz(e);
      const failed = e.results.filter((r) => r.status === 'FAIL' || r.status === 'STOP');
      expect(failed).toEqual([]);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
