import { randomUUID } from 'crypto';
import { BizEnv, abortBiz, approvedDoc, attempt, auditChainValid, finishBiz, fp, fpDiff, negativeStockPairs, onHand, receive, record, reserved, result, seedProduct, seedWarehouse, setUpBiz } from './biz-support';
import { reconcileAndRecord } from './biz-reconcile';
import { BomService } from '../../domains/commerce/application/bom.service';
import { ProductsService } from '../../domains/commerce/application/products.service';

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
      // BOM contract now wired in the harness (real BomService): F = 2 x C1 + 3 x C2; stock C1 = 10, C2 = 5; assembling 2 units needs 6 of C2 (> 5).
      const F = await seedProduct(e.dsA, 'T02-F');
      const C1 = await seedProduct(e.dsA, 'T02-C1');
      const C2 = await seedProduct(e.dsA, 'T02-C2');
      await receive(e, W1, C1, 10);
      await receive(e, W1, C2, 5);
      const bomSvc = new BomService(e.h.controlPlane, e.audit, new ProductsService(e.h.controlPlane, e.audit, {} as never));
      await bomSvc.defineBom(F, [{ componentProductId: C1, quantityPerUnit: 2 }, { componentProductId: C2, quantityPerUnit: 3 }], e.actor, e.manager);
      const beforeD = await fp(e);
      const outD = await attempt(() => e.inventory.assembleProduct(W1, F, 2, e.actor, e.manager));
      const afterD = await fp(e);
      const okD = !outD.ok && outD.kind.endsWith(':409') && fpDiff(beforeD, afterD).length === 0 && (await onHand(e, W1, C1)) === 10 && (await onHand(e, W1, C2)) === 5 && (await onHand(e, W1, F)) === 0;
      record(e, 'T-02d.json', { outcome: outD, fingerprintDiff: fpDiff(beforeD, afterD), note: 'the assembly number is drawn before the transaction (numbering sequence is not in the fingerprint set): a refused assembly may leave a gap in the sequence, not a data effect' });
      result(e, 'T-02d', okD ? 'PASS' : 'FAIL', JSON.stringify(outD));
      // (a successful assembly is not exercised here: the harness event bus is a stub, so the positive path is covered by the Work Order/assembly specs, not by this refusal case)

      // ---------- global invariants ----------
      expect(await negativeStockPairs(e)).toBe(0);
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
