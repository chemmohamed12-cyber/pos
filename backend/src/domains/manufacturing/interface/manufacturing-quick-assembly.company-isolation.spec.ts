import { MfgKit, setUpMfgKit } from './manufacturing-engine-test-kit';
import { QuickAssemblyService } from '../application/quick-assembly.service';

/**
 * Manufacturing Engine S6 (decision D-ME-5) - quick assembly on the Work Order path, real PostgreSQL: one call leaves a completed Work Order (number, events, journals), WIP at zero,
 * the finished stock at the consumed cost - and a failure rolls EVERYTHING back (no order, no movement, no journal left behind). Company B is the witness.
 */
describe('Manufacturing Engine S6 - quick assembly on the Work Order path - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let k: MfgKit;
  let quick: QuickAssemblyService;
  const p: Record<string, string> = {};

  beforeAll(async () => {
    k = await setUpMfgKit('mfg_s6');
    quick = new QuickAssemblyService(k.h.controlPlane, k.wo);
    for (const key of ['lamp', 'body', 'cap']) p[key] = await k.product(`S6-${key.toUpperCase()}`, key);
    await k.stock([
      { productId: p.body, sku: 'S6-BODY', quantity: 100, unitCost: '10.00' },
      { productId: p.cap, sku: 'S6-CAP', quantity: 10, unitCost: '2.00' },
    ]);
    await k.bom.defineBom(p.lamp, [{ componentProductId: p.body, quantityPerUnit: 1 }, { componentProductId: p.cap, quantityPerUnit: 2 }], k.actor, await k.mgr());
  });
  afterAll(async () => k.teardown());

  it('S6-1 assembling 5 leaves a completed order, WIP and GL at zero, stock moved, and the finished cost = what was consumed', async () => {
    const inv0 = await k.glBalance('1120');
    const r = await quick.quickAssemble(k.warehouseId, p.lamp, 5, k.actor, await k.mgr());
    await k.flush();
    expect(r.workOrderNumber).toMatch(/^WO-/);
    expect(await k.wo.getWorkOrderState(r.workOrderId, await k.mgr())).toBe('completed');
    expect(await k.wo.computeWipValue(r.workOrderId, await k.mgr())).toBeCloseTo(0, 4);
    expect(await k.glBalance('1150')).toBeCloseTo(0, 4);
    expect(await k.glBalance('1120')).toBeCloseTo(inv0, 4); // 5x10 + 10x2 = 70 left components and came back as the 5 lamps
    expect(await k.onHand(k.warehouseId, p.lamp)).toBe(5);
    expect(await k.onHand(k.warehouseId, p.body)).toBe(95);
    expect(await k.onHand(k.warehouseId, p.cap)).toBe(0);
    const row = (await k.q(`SELECT count(*)::int AS n FROM "accounting_financial_events" WHERE "idempotencyKey" LIKE $1`, [`manufacturing:work_order:${r.workOrderId}:%`]))[0];
    expect(row.n).toBeGreaterThanOrEqual(3); // material issues + output: the same event trail as any order
  });

  it('S6-2 a shortage rolls everything back: no order, no movement, no journal', async () => {
    const orders0 = (await k.q(`SELECT count(*)::int AS n FROM "work_orders"`))[0].n;
    const moves0 = (await k.q(`SELECT count(*)::int AS n FROM "stock_movements"`))[0].n;
    const gl0 = await k.glBalance('1150');
    await expect(quick.quickAssemble(k.warehouseId, p.lamp, 50, k.actor, await k.mgr())).rejects.toThrow(); // caps: only 0 left
    expect((await k.q(`SELECT count(*)::int AS n FROM "work_orders"`))[0].n).toBe(orders0);
    expect((await k.q(`SELECT count(*)::int AS n FROM "stock_movements"`))[0].n).toBe(moves0);
    expect(await k.glBalance('1150')).toBeCloseTo(gl0, 4);
  });

  it('S6-3 Company B (the witness) is untouched', async () => {
    const b = await k.h.connections.getDataSource(k.h.companyBId);
    // S6-1 created exactly one order in company A; B must still have none.
    expect((await b.query(`SELECT count(*)::int AS n FROM "work_orders"`))[0].n).toBe(0);
  });

  describe('UX stage 2 - read-only preview (D8)', () => {
    let preview: QuickAssemblyService;
    beforeAll(async () => {
      preview = new QuickAssemblyService(k.h.controlPlane, k.wo, k.bom as never);
      for (const key of ['lamp2', 'body2', 'cap2']) p[key] = await k.product(`S6-${key.toUpperCase()}`, key);
      await k.stock([
        { productId: p.body2, sku: 'S6-BODY2', quantity: 10, unitCost: '10.00' },
        { productId: p.cap2, sku: 'S6-CAP2', quantity: 4, unitCost: '2.00' },
      ]);
      await k.bom.defineBom(p.lamp2, [{ componentProductId: p.body2, quantityPerUnit: 1 }, { componentProductId: p.cap2, quantityPerUnit: 2 }], k.actor, await k.mgr());
    });

    it('S6-4 reports requirements, availability and shortage per component, and posts nothing', async () => {
      const orders0 = (await k.q(`SELECT count(*)::int AS n FROM "work_orders"`))[0].n;
      const moves0 = (await k.q(`SELECT count(*)::int AS n FROM "stock_movements"`))[0].n;
      const ok = await preview.preview(p.lamp2, k.warehouseId, 2, await k.mgr());
      expect(ok.blockers).toEqual([]);
      expect(ok.canAssemble).toBe(true);
      expect(ok.components.map((c) => [c.sku, c.required, c.available, c.shortage, c.status]).sort()).toEqual([
        ['S6-BODY2', 2, 10, 0, 'ok'],
        ['S6-CAP2', 4, 4, 0, 'ok'],
      ]);
      const short = await preview.preview(p.lamp2, k.warehouseId, 3, await k.mgr()); // caps: needs 6, has 4
      expect(short.canAssemble).toBe(false);
      expect(short.blockers.map((b) => b.code)).toContain('shortage');
      expect(short.components.find((c) => c.sku === 'S6-CAP2')).toMatchObject({ required: 6, available: 4, shortage: 2, status: 'short' });
      expect((await k.q(`SELECT count(*)::int AS n FROM "work_orders"`))[0].n).toBe(orders0);
      expect((await k.q(`SELECT count(*)::int AS n FROM "stock_movements"`))[0].n).toBe(moves0);
    });

    it('S6-5 a product without an active BOM, a bad quantity and an unknown warehouse are explained, not thrown', async () => {
      const noBom = await preview.preview(p.body, k.warehouseId, 1, await k.mgr());
      expect(noBom.blockers.map((b) => b.code)).toContain('no_active_bom');
      const badQty = await preview.preview(p.lamp2, k.warehouseId, 1.5, await k.mgr());
      expect(badQty.blockers.map((b) => b.code)).toContain('invalid_quantity');
      const noWh = await preview.preview(p.lamp2, '00000000-0000-0000-0000-000000000000', 1, await k.mgr());
      expect(noWh.blockers.map((b) => b.code)).toContain('warehouse_not_found');
      expect(noWh.canAssemble).toBe(false);
    });

    it('S6-6 the preview is not a reservation: the real assembly still revalidates and succeeds/fails on its own', async () => {
      const ok = await preview.preview(p.lamp2, k.warehouseId, 2, await k.mgr());
      expect(ok.blockers).toEqual([]);
      expect(ok.canAssemble).toBe(true);
      const r = await preview.quickAssemble(k.warehouseId, p.lamp2, 2, k.actor, await k.mgr());
      expect(r.workOrderNumber).toMatch(/^WO-/);
    });
  });
});
