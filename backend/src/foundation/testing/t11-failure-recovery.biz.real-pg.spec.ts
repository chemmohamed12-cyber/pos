import { abortBiz, approvedDoc, attempt, auditProbe, finishBiz, record, result } from './biz-support';
import { InvGlEnv, eventsOfKind, journalCount, journalLines, setUpInventoryGl, valuationOf } from './biz-inventory-gl-support';
import { reconcileAndRecord } from './biz-reconcile';

/**
 * T-11 (G2: failure between the stock movement and its accounting event; recovery by re-drive) — FROZEN in
 * docs/decisions/test-program/T-PLAN-FROZEN-2026-10-10.md. Fixture: on-hand 5 @4.00 (opening stock), COGS account configured.
 * Steps / Expected (frozen):
 *  (1) an issue posts: event POSTED, one journal (5101 D 4.00 / 1120 C 4.00);
 *  (2) COGS configuration removed, another issue posts: the movement EXISTS, its event is REJECTED with the COGS reason, NO journal, valuation NOT mutated;
 *  (3) configuration restored, the rejected event is re-driven: POSTED exactly once, exactly one journal;
 *  (4) re-driving two more times adds nothing (journal count unchanged, no duplicate event or journal).
 * R2/R7 hold after recovery. Disposable databases `daii_test_biz_t11_*` only. No product-code change: the failure is provoked purely by configuration.
 */
describe('T-11 — a failed accounting event is visible, re-drivable and never duplicates its effect', () => {
  jest.setTimeout(900_000);
  let env: InvGlEnv | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('issue -> rejected event -> restore configuration -> re-drive (x3)', async () => {
    try {
      env = await setUpInventoryGl('T-11', 'biz_t11');
      const e = env;
      const W = e.warehouseId;
      const P = e.productId;
      const post = async () => {
        const doc = await approvedDoc(e, 'issue', W, [{ productId: P, quantity: 1 }]);
        const out = await attempt(() => e.whTx.transition(doc, 'post', e.actor, e.manager));
        await e.flush();
        return { doc, out };
      };

      // (1)
      const s1 = await post();
      const ev1 = await eventsOfKind(e, 'dispatch');
      const ok1 = s1.out.ok && ev1.length === 1 && ev1[0].status === 'POSTED' && JSON.stringify(await journalLines(e, ev1[0].journalEntryId!)) === JSON.stringify(['5101 D 4.00', '1120 C 4.00']);
      const val1 = await valuationOf(e);
      record(e, 'T-11-1.json', { out: s1.out, events: ev1, valuation: val1 });
      result(e, 'T-11-1', ok1 && val1.qty === 4 && val1.value === 16 ? 'PASS' : 'STOP', JSON.stringify({ ev1, val1 }));

      // (2) provoke the failure with configuration only
      const saved = e.cfg['accounting.inventory_cogs_account_code'];
      delete e.cfg['accounting.inventory_cogs_account_code'];
      const journalsBefore2 = await journalCount(e);
      const s2 = await post();
      const ev2 = await eventsOfKind(e, 'dispatch');
      const rejected = ev2.filter((x) => x.status === 'REJECTED');
      const movement2 = (await e.dsA.query(`SELECT count(*)::int AS n FROM stock_movements WHERE "movementType" = 'dispatch' AND "productId" = $1`, [P]))[0].n;
      const val2 = await valuationOf(e);
      const ok2 = s2.out.ok && movement2 === 2 && rejected.length === 1 && /COGS/i.test(rejected[0].rejectionReason ?? '') && rejected[0].journalEntryId === null &&
        (await journalCount(e)) === journalsBefore2 && val2.qty === 4 && val2.value === 16;
      record(e, 'T-11-2.json', { out: s2.out, events: ev2, movements: movement2, valuation: val2, journals: await journalCount(e) });
      result(e, 'T-11-2', ok2 ? 'PASS' : 'STOP', JSON.stringify({ rejected, movement2, val2 }));

      // (3) restore configuration, re-drive the rejected event
      e.cfg['accounting.inventory_cogs_account_code'] = saved;
      const redriven = await attempt(() => e.financialEvents.redrive(rejected[0].id, e.manager));
      const ev3 = await eventsOfKind(e, 'dispatch');
      const posted3 = ev3.filter((x) => x.status === 'POSTED');
      const lines3 = posted3.length === 2 ? await journalLines(e, posted3[1].journalEntryId!) : [];
      const journals3 = await journalCount(e);
      const val3 = await valuationOf(e);
      record(e, 'T-11-3.json', { redriven, events: ev3, journals: journals3, valuation: val3 });
      const ok3 = redriven.ok && posted3.length === 2 && ev3.length === 2 && JSON.stringify(lines3) === JSON.stringify(['5101 D 4.00', '1120 C 4.00']) && val3.qty === 3 && val3.value === 12;
      result(e, 'T-11-3', ok3 ? 'PASS' : 'STOP', JSON.stringify({ redriven, statuses: ev3.map((x) => x.status), val3 }));

      // (4) idempotent re-drives
      const again = [await attempt(() => e.financialEvents.redrive(rejected[0].id, e.manager)), await attempt(() => e.financialEvents.redrive(rejected[0].id, e.manager))];
      const ev4 = await eventsOfKind(e, 'dispatch');
      const journals4 = await journalCount(e);
      const val4 = await valuationOf(e);
      record(e, 'T-11-4.json', { again, events: ev4.map((x) => x.status), journals: journals4, valuation: val4 });
      const ok4 = ev4.length === 2 && ev4.every((x) => x.status === 'POSTED') && journals4 === journals3 && val4.qty === 3 && val4.value === 12;
      result(e, 'T-11-4', ok4 ? 'PASS' : 'STOP', JSON.stringify({ again, journals3, journals4, val4 }));

      await auditProbe(e, 'final');
      await reconcileAndRecord(e, { notes: ['T-11 step (2) intentionally left one REJECTED event; it was re-driven in steps (3)-(4), so no event remains unexplained at reconciliation time'] });
      await finishBiz(e);
      expect(e.results.filter((r) => r.status === 'FAIL' || r.status === 'STOP')).toEqual([]);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
