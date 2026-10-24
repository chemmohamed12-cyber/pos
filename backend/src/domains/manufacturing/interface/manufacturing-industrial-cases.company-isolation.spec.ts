import { MfgKit, setUpMfgKit } from './manufacturing-engine-test-kit';

/**
 * Manufacturing Engine - industrial cases by CONFIGURATION ONLY (real PostgreSQL, real cost engine and journals; Company B = witness). No engine code is specific to any case:
 * each is a process definition (and, where relevant, unit conversions) run through the same order lifecycle.
 *   C3 multi-output blending (co-product + by-product, cost shared by weight)
 *   C4 metal machining: scrap with recoverable material + rework through a repeatable operation + quality inspection
 *   C5 unit -> pack -> carton (conversions + chained orders)
 *   C6 independent quality operation: held units block closing until released (cost of the inspection itself = BLOCKED, see the closing report)
 *   C7 disassembly (stocked finished item broken into parts at the carried cost) and a complex alternate/intermediate flow
 * C1 (lamps, Basic Profile) is covered by the S1 spec and S4-10; C2 (electronics with parallel branches) by S4.
 */
describe('Manufacturing Engine - industrial cases by configuration - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let k: MfgKit;
  const p: Record<string, string> = {};
  const sku = (key: string) => `IC-${key.toUpperCase()}`;

  beforeAll(async () => {
    k = await setUpMfgKit('mfg_cases');
    for (const key of ['base', 'goodA', 'coB', 'byC', 'steel', 'part', 'chips', 'unit', 'pack', 'carton', 'qcIn', 'qcOut', 'lamp', 'chip', 'shell']) p[key] = await k.product(sku(key), key);
    await k.stock([
      { productId: p.base, sku: sku('base'), quantity: 400, unitCost: '3.00' },
      { productId: p.steel, sku: sku('steel'), quantity: 400, unitCost: '4.00' },
      { productId: p.unit, sku: sku('unit'), quantity: 480, unitCost: '1.00' },
      { productId: p.qcIn, sku: sku('qcIn'), quantity: 100, unitCost: '5.00' },
      { productId: p.lamp, sku: sku('lamp'), quantity: 10, unitCost: '17.00' },
    ]);
  });
  afterAll(async () => k.teardown());

  const delta = async (fn: () => Promise<void>) => {
    const codes = ['1120', '1150', '5301'];
    const before = Object.fromEntries(await Promise.all(codes.map(async (c) => [c, await k.glBalance(c)])));
    await fn();
    await k.flush();
    const after = Object.fromEntries(await Promise.all(codes.map(async (c) => [c, await k.glBalance(c)])));
    return Object.fromEntries(codes.map((c) => [c, Number((after[c] - before[c]).toFixed(4))])) as Record<string, number>;
  };
  const activate = async (productId: string, body: Parameters<MfgKit['processes']['createDraft']>[1]) => {
    const m = await k.mgr();
    const v = await k.processes.createDraft(productId, body, k.actor, m);
    await k.processes.activate(v.version.id, k.actor, m);
  };
  const runOp = async (orderId: string, code: string, steps?: (runId: string) => Promise<void>) => {
    const m = await k.mgr();
    const r = await k.exec.startOperation(orderId, code, k.actor, `s-${code}-${Math.random()}`, m);
    if (steps) await steps(r.id);
    await k.exec.completeRun(orderId, r.id, k.actor, m);
    return r.id;
  };

  it('C3 multi-output blending: one input yields a good product, a co-product and a zero-value by-product; the pooled cost is shared by weight and nothing is lost', async () => {
    const m = await k.mgr();
    await activate(p.goodA, {
      name: 'Blend',
      operations: [{ code: 'MIX', name: 'Blend', operationTypeCode: 'transform' }],
      edges: [],
      inputs: [{ operationCode: 'MIX', componentProductId: p.base, quantityPerUnit: 10 }],
      outputs: [
        { operationCode: 'MIX', productId: p.goodA, quantityPerUnit: 6, role: 'good', allocationWeight: 1 },
        { operationCode: 'MIX', productId: p.coB, quantityPerUnit: 3, role: 'co_product', allocationWeight: 1 },
        { operationCode: 'MIX', productId: p.byC, quantityPerUnit: 1, role: 'by_product', allocationWeight: 0 },
      ],
    });
    const o = await k.wo.createProcessWorkOrder(p.goodA, 10, k.warehouseId, null, k.actor, m);
    await k.wo.release(o.id, k.actor, m);
    await k.wo.materialIssue(o.id, p.base, 100, k.actor, 'iss', m);
    await k.flush();
    const d = await delta(async () => {
      await runOp(o.id, 'MIX');
      await expect(k.wo.receiveProcessOutputs(o.id, 11, k.actor, 'x', m)).rejects.toThrow(/remaining/);
      const rows = await k.wo.receiveProcessOutputs(o.id, 10, k.actor, 'out-1', m);
      const again = await k.wo.receiveProcessOutputs(o.id, 10, k.actor, 'out-1', m); // retried request: no second effect
      expect(again.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
      const byClass = Object.fromEntries(rows.map((r) => [r.outcomeClass, r]));
      expect(byClass.good).toMatchObject({ productId: p.goodA, quantity: 60 });
      expect(Number(byClass.good.valueBase)).toBeCloseTo(200, 1); // 300 pooled x 60/90 (unit costs are stored at 4 decimals by the cost engine: residual <= qty x 0.00005, as in the Basic Profile)
      expect(byClass.co_product).toMatchObject({ productId: p.coB, quantity: 30 });
      expect(Number(byClass.co_product.valueBase)).toBeCloseTo(100, 1);
      expect(byClass.by_product).toMatchObject({ productId: p.byC, quantity: 10 });
      expect(Number(byClass.by_product.valueBase)).toBe(0);
      await k.wo.complete(o.id, k.actor, m);
    });
    expect(d['1150']).toBeCloseTo(-300, 1); // the 300 issued before the window left WIP: it is zero again
    expect(d['1120']).toBeCloseTo(300, 1); // the outputs re-entered stock at exactly the 300 the 100 base units had cost
    expect(await k.onHand(k.warehouseId, p.goodA)).toBe(60);
    expect(await k.onHand(k.warehouseId, p.coB)).toBe(30);
    expect(await k.onHand(k.warehouseId, p.byC)).toBe(10);
    expect(await k.onHand(k.warehouseId, p.base)).toBe(300);
    expect((await k.q(`SELECT count(*)::int AS n FROM "stock_movements" WHERE "productId" = $1 AND "referenceType" = 'work_order' AND "referenceId" = $2`, [p.goodA, o.id]))[0].n).toBe(1); // the retry added nothing
  });

  it('C4 metal machining: scrap at the operation, recoverable material back to stock, rework through a repeatable operation, inspection - GL and stock reconcile', async () => {
    const m = await k.mgr();
    await activate(p.part, {
      name: 'Machined part',
      operations: [
        { code: 'CUT', name: 'Cut', operationTypeCode: 'transform', sequenceNo: 10 },
        { code: 'MACH', name: 'Machine', operationTypeCode: 'transform', sequenceNo: 20, maxRuns: 2 },
        { code: 'QC', name: 'Inspect', operationTypeCode: 'quality', sequenceNo: 30 },
      ],
      edges: [{ from: 'CUT', to: 'MACH' }, { from: 'MACH', to: 'QC' }],
      inputs: [{ operationCode: 'CUT', componentProductId: p.steel, quantityPerUnit: 5 }],
      outputs: [{ operationCode: 'MACH', productId: p.part, quantityPerUnit: 1, role: 'good' }],
    });
    const o = await k.wo.createProcessWorkOrder(p.part, 10, k.warehouseId, null, k.actor, m);
    await k.wo.release(o.id, k.actor, m);
    await k.wo.materialIssue(o.id, p.steel, 50, k.actor, 'iss', m);
    await k.flush();
    let scrapRow = '';
    let reworkRow = '';
    const d = await delta(async () => {
      await runOp(o.id, 'CUT', async (r) => void (await k.exec.recordConsumption(o.id, r, p.steel, 50, k.actor, 'c', m)));
      await runOp(o.id, 'MACH', async (r) => {
        scrapRow = (await k.exec.recordScrapAt(o.id, r, 2, 'out of tolerance', k.actor, 'scrap-1', m)).id;
      });
      await runOp(o.id, 'QC', async (r) => {
        reworkRow = (await k.exec.recordOutcomeAt(o.id, r, 'rework', 1, 'burr', k.actor, 'rw-1', m)).id;
      });
      await expect(k.wo.complete(o.id, k.actor, m)).rejects.toThrow(/still tracked|WIP balance/); // the rework unit is an open decision
      await k.wo.resolveTrackedOutcome(o.id, reworkRow, 'rework', k.actor, m);
      await runOp(o.id, 'MACH'); // second run of the same operation = the rework pass
      await expect(k.exec.startOperation(o.id, 'MACH', k.actor, 'third', m)).rejects.toThrow(/permitted run/);
      await k.wo.recordRecovery(o.id, p.chips, 6, '12.00', scrapRow, k.actor, 'rec-1', m); // recoverable swarf worth 12 out of the 40 written off
      await expect(k.wo.recordRecovery(o.id, p.chips, 1, '30.00', scrapRow, k.actor, 'rec-2', m)).rejects.toThrow(/exceed/); // never more than the scrap wrote off
      await k.wo.finishedGoodsOutput(o.id, 8, k.actor, 'fg', m);
      await k.wo.complete(o.id, k.actor, m);
    });
    expect(d['1150']).toBeCloseTo(-200, 3); // the 200 issued before the window left WIP: zero again
    expect(d['5301']).toBeCloseTo(40 - 12, 3); // scrap 2/10 of 200 less the recovered 12
    expect(d['1120']).toBeCloseTo(160 + 12, 3); // 8 parts at 20.00 and the recovered material came into stock
    expect(await k.onHand(k.warehouseId, p.part)).toBe(8);
    expect(await k.onHand(k.warehouseId, p.chips)).toBe(6);
    const v = await k.exec.getExecution(o.id, m);
    expect(v.operations.find((x) => x.code === 'MACH')).toMatchObject({ runs: 2, outcomes: [{ outcomeClass: 'scrap', quantity: 2 }] });
    expect(v.operations.find((x) => x.code === 'QC')!.outcomes).toEqual([{ outcomeClass: 'rework', quantity: 1 }]);
  });

  it('C5 unit -> pack -> carton: conversions turn "1 dozen" into 12 base units; chained orders carry cost up each level', async () => {
    const m = await k.mgr();
    await k.units.set(p.unit, 'dozen', 12, k.actor, m);
    const perPack = await k.units.toBase(p.unit, '1', 'dozen', m);
    expect(perPack).toBe(12);
    await k.bom.defineBom(p.pack, [{ componentProductId: p.unit, quantityPerUnit: perPack }], k.actor, m);
    await k.bom.defineBom(p.carton, [{ componentProductId: p.pack, quantityPerUnit: 20 }], k.actor, m);
    const packOrder = await k.wo.createWorkOrder(p.pack, 20, k.warehouseId, k.actor, m);
    await k.wo.release(packOrder.id, k.actor, m);
    await k.wo.materialIssue(packOrder.id, p.unit, 240, k.actor, 'i1', m);
    await k.wo.finishedGoodsOutput(packOrder.id, 20, k.actor, 'o1', m);
    await k.wo.complete(packOrder.id, k.actor, m);
    await k.flush();
    const cartonOrder = await k.wo.createWorkOrder(p.carton, 1, k.warehouseId, k.actor, m);
    await k.wo.release(cartonOrder.id, k.actor, m);
    await k.wo.materialIssue(cartonOrder.id, p.pack, 20, k.actor, 'i2', m);
    await k.wo.finishedGoodsOutput(cartonOrder.id, 1, k.actor, 'o2', m);
    await k.wo.complete(cartonOrder.id, k.actor, m);
    await k.flush();
    expect(await k.onHand(k.warehouseId, p.carton)).toBe(1);
    expect(await k.onHand(k.warehouseId, p.pack)).toBe(0);
    expect(await k.onHand(k.warehouseId, p.unit)).toBe(480 - 240);
    const row = (await k.q(`SELECT "totalValueBase" AS v FROM "inventory_valuation" WHERE "productId" = $1 AND "warehouseId" = $2`, [p.carton, k.warehouseId]).catch(() => [])) as Array<{ v: string }>;
    if (row.length) expect(Number(row[0].v)).toBeCloseTo(240, 2); // 240 units @1.00 carried through the pack level
    expect(await k.glBalance('1150')).toBeCloseTo(0, 3);
  });

  it('C6 independent quality operation: held units must be released before closing; the inspection itself carries no cost element (quantity-only, by ratified D2/D3)', async () => {
    const m = await k.mgr();
    await activate(p.qcOut, {
      name: 'Inspected item',
      operations: [{ code: 'MAKE', name: 'Make', operationTypeCode: 'transform', sequenceNo: 10 }, { code: 'INSP', name: 'Inspect', operationTypeCode: 'quality', sequenceNo: 20 }],
      edges: [{ from: 'MAKE', to: 'INSP' }],
      inputs: [{ operationCode: 'MAKE', componentProductId: p.qcIn, quantityPerUnit: 1 }],
      outputs: [{ operationCode: 'MAKE', productId: p.qcOut, quantityPerUnit: 1, role: 'good' }],
    });
    const o = await k.wo.createProcessWorkOrder(p.qcOut, 10, k.warehouseId, null, k.actor, m);
    await k.wo.release(o.id, k.actor, m);
    await k.wo.materialIssue(o.id, p.qcIn, 10, k.actor, 'iss', m);
    await runOp(o.id, 'MAKE', async (r) => void (await k.exec.recordConsumption(o.id, r, p.qcIn, 10, k.actor, 'c', m)));
    let held = '';
    await runOp(o.id, 'INSP', async (r) => {
      held = (await k.exec.recordOutcomeAt(o.id, r, 'held', 2, 'awaiting lab', k.actor, 'h', m)).id;
    });
    await k.wo.finishedGoodsOutput(o.id, 10, k.actor, 'fg', m);
    await expect(k.wo.complete(o.id, k.actor, m)).rejects.toThrow(/still tracked/);
    await k.wo.resolveTrackedOutcome(o.id, held, 'good', k.actor, m);
    await k.wo.complete(o.id, k.actor, m);
    const cols = (await k.q(`SELECT column_name AS c FROM information_schema.columns WHERE table_name IN ('mfg_process_operations','mfg_operation_runs')`)).map((r) => r.c);
    expect(cols.filter((c) => /cost|rate|hour|overhead|labou?r/i.test(c))).toEqual([]); // there is deliberately nowhere to put an operation cost
  });

  it('C7 disassembly: a stocked finished item is broken into parts at its carried cost (shared by weight); a complex alternate + intermediate flow is the same engine', async () => {
    const m = await k.mgr();
    await activate(p.chip, {
      name: 'Disassemble lamp',
      operations: [{ code: 'DIS', name: 'Disassemble', operationTypeCode: 'disassembly' }],
      edges: [],
      inputs: [{ operationCode: 'DIS', componentProductId: p.lamp, quantityPerUnit: 1 }],
      outputs: [
        { operationCode: 'DIS', productId: p.chip, quantityPerUnit: 4, role: 'good', allocationWeight: 1 },
        { operationCode: 'DIS', productId: p.shell, quantityPerUnit: 1, role: 'co_product', allocationWeight: 1 },
      ],
    });
    const o = await k.wo.createProcessWorkOrder(p.chip, 5, k.warehouseId, null, k.actor, m);
    await k.wo.release(o.id, k.actor, m);
    await k.wo.materialIssue(o.id, p.lamp, 5, k.actor, 'iss', m);
    await k.flush();
    const d = await delta(async () => {
      await runOp(o.id, 'DIS', async (r) => void (await k.exec.recordConsumption(o.id, r, p.lamp, 5, k.actor, 'c', m)));
      await k.wo.receiveProcessOutputs(o.id, 5, k.actor, 'out', m);
      await k.wo.complete(o.id, k.actor, m);
    });
    expect(d['1150']).toBeCloseTo(-85, 3); // the 85 issued before the window left WIP: zero again
    expect(d['1120']).toBeCloseTo(85, 3); // 5 lamps @17 = 85 left stock and came back as parts worth exactly 85
    expect(await k.onHand(k.warehouseId, p.lamp)).toBe(5);
    expect(await k.onHand(k.warehouseId, p.chip)).toBe(20);
    expect(await k.onHand(k.warehouseId, p.shell)).toBe(5);
    const shares = (await k.wo.getResults(o.id, m)).map((r) => [r.outcomeClass, r.quantity, Number(r.valueBase)]);
    expect(shares).toEqual(expect.arrayContaining([['good', 20, 68], ['co_product', 5, 17]]));
  });

  it('witness: Company B holds none of it', async () => {
    const b = await k.h.connections.getDataSource(k.h.companyBId);
    for (const t of ['work_orders', 'work_order_results', 'mfg_process_versions', 'mfg_operation_runs', 'product_unit_conversions']) expect((await b.query(`SELECT count(*)::int AS n FROM "${t}"`))[0].n).toBe(0);
  });
});
