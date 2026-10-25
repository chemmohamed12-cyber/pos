import { ConflictException } from '@nestjs/common';
import { MfgKit, setUpMfgKit } from './manufacturing-engine-test-kit';

/**
 * Manufacturing Engine S4 (decision D-ME-3) - execution of a process version on a Work Order, real PostgreSQL with the REAL cost engine and journals (Company B = witness).
 * Electronics-style process: two PARALLEL branches (board, housing) join in assembly, then an OPTIONAL repeatable inspection; one alternate group (wire A / wire B).
 * Proves: process-bound creation + release snapshot of RAW material only, graph gating (parallel / join / optional / repeat), per-operation consumption bounded by plan, by issued
 * stock and by earlier yields, the derived per-operation ledger (quantity + material value at the WIP unit cost), idempotent retries, completion rules, and that the
 * unchanged order lifecycle still reconciles WIP / GL / stock to zero - with the Basic Profile untouched.
 */
describe('Manufacturing Engine S4 - process execution (graph, runs, per-operation ledger) - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let k: MfgKit;
  const p: Record<string, string> = {};
  let orderId = '';
  let wip = '';
  const run: Record<string, string> = {};

  beforeAll(async () => {
    k = await setUpMfgKit('mfg_s4');
    for (const [key, sku, name] of [
      ['lamp', 'S4-LAMP', 'Lamp'], ['pcb', 'S4-PCB', 'PCB'], ['body', 'S4-BODY', 'Body'], ['chip', 'S4-CHIP', 'Chip'], ['wireA', 'S4-WIREA', 'Wire A'], ['wireB', 'S4-WIREB', 'Wire B'], ['shell', 'S4-SHELL', 'Shell'], ['basic', 'S4-BASIC', 'Basic item'], ['basicC', 'S4-BASICC', 'Basic component'],
    ] as const) {
      p[key] = await k.product(sku, name);
    }
    await k.stock([
      { productId: p.chip, sku: 'S4-CHIP', quantity: 200, unitCost: '2.00' },
      { productId: p.wireA, sku: 'S4-WIREA', quantity: 200, unitCost: '1.50' },
      { productId: p.wireB, sku: 'S4-WIREB', quantity: 200, unitCost: '4.00' },
      { productId: p.shell, sku: 'S4-SHELL', quantity: 200, unitCost: '6.00' },
      { productId: p.basicC, sku: 'S4-BASICC', quantity: 100, unitCost: '3.00' },
    ]);
    const m = await k.mgr();
    const v = await k.processes.createDraft(
      p.lamp,
      {
        name: 'Lamp electronics',
        operations: [
          { code: 'BOARD', name: 'Make board', operationTypeCode: 'transform', sequenceNo: 10 },
          { code: 'HOUSE', name: 'Make housing', operationTypeCode: 'transform', sequenceNo: 10 },
          { code: 'ASM', name: 'Assemble', operationTypeCode: 'assembly', sequenceNo: 20 },
          { code: 'QC', name: 'Inspect', operationTypeCode: 'quality', sequenceNo: 30, optional: true, maxRuns: 2 },
        ],
        edges: [{ from: 'BOARD', to: 'ASM' }, { from: 'HOUSE', to: 'ASM' }, { from: 'ASM', to: 'QC' }],
        inputs: [
          { operationCode: 'BOARD', componentProductId: p.chip, quantityPerUnit: 4 },
          { operationCode: 'BOARD', componentProductId: p.wireA, quantityPerUnit: 2, alternateGroup: 'WIRE' },
          { operationCode: 'BOARD', componentProductId: p.wireB, quantityPerUnit: 2, alternateGroup: 'WIRE' },
          { operationCode: 'HOUSE', componentProductId: p.shell, quantityPerUnit: 1 },
          { operationCode: 'ASM', componentProductId: p.pcb, quantityPerUnit: 1 },
          { operationCode: 'ASM', componentProductId: p.body, quantityPerUnit: 1 },
        ],
        outputs: [
          { operationCode: 'BOARD', productId: p.pcb, quantityPerUnit: 1, role: 'good', intermediate: true },
          { operationCode: 'HOUSE', productId: p.body, quantityPerUnit: 1, role: 'good', intermediate: true },
          { operationCode: 'ASM', productId: p.lamp, quantityPerUnit: 1, role: 'good' },
        ],
      },
      k.actor,
      m,
    );
    await k.processes.activate(v.version.id, k.actor, m);
  });
  afterAll(async () => k.teardown());

  const choices = (wire: string) => ({ 'BOARD|WIRE': wire });
  const ex = async (fn: () => Promise<unknown>) => fn().then(() => null, (e) => e as Error);

  it('S4-1 creation needs an ACTIVE version and an explicit, valid choice for every alternate group', async () => {
    const m = await k.mgr();
    expect(await ex(() => k.wo.createProcessWorkOrder(p.basic, 5, k.warehouseId, null, k.actor, m))).toBeInstanceOf(ConflictException); // no active process
    await expect(k.wo.createProcessWorkOrder(p.lamp, 10, k.warehouseId, null, k.actor, m)).rejects.toThrow(/Choose one alternative/);
    await expect(k.wo.createProcessWorkOrder(p.lamp, 10, k.warehouseId, choices(p.shell), k.actor, m)).rejects.toThrow(/not one of the alternatives/);
    const o = await k.wo.createProcessWorkOrder(p.lamp, 10, k.warehouseId, choices(p.wireA), k.actor, m);
    orderId = o.id;
    expect(o.processVersionId).toBeTruthy();
  });

  it('S4-2 release snapshots only the RAW material of the chosen alternatives (no intermediates, no wire B) and reserves it', async () => {
    const m = await k.mgr();
    const released = await k.wo.release(orderId, k.actor, m);
    wip = released.wipWarehouseId!;
    const comps = await k.wo.getWorkOrderComponents(orderId, m);
    const need = Object.fromEntries(comps.map((c) => [c.componentProductId, c.quantityRequired]));
    expect(need).toEqual({ [p.chip]: 40, [p.wireA]: 20, [p.shell]: 10 });
    expect(await k.wo.getWorkOrderOperations(orderId, m)).toHaveLength(0); // no routing snapshot for a process order
  });

  it('S4-3 operations run only while the order is in progress: before material is issued nothing starts', async () => {
    await expect(k.exec.startOperation(orderId, 'BOARD', k.actor, 'r-early', await k.mgr())).rejects.toThrow(/in progress|released/);
    const m = await k.mgr();
    await k.wo.materialIssue(orderId, p.chip, 40, k.actor, 'iss-chip', m);
    await k.wo.materialIssue(orderId, p.wireA, 20, k.actor, 'iss-wire', m);
    await k.wo.materialIssue(orderId, p.shell, 10, k.actor, 'iss-shell', m);
    await k.flush();
    expect(await k.wo.computeWipValue(orderId, m)).toBeCloseTo(170, 4); // 40x2 + 20x1.5 + 10x6
    expect(await k.wo.getWorkOrderState(orderId, m)).toBe('in_progress');
  });

  it('S4-4 the graph gates the order: the join waits for BOTH parallel branches, the optional inspection for assembly', async () => {
    const m = await k.mgr();
    await expect(k.exec.startOperation(orderId, 'ASM', k.actor, 'r-asm-early', m)).rejects.toThrow(/waiting for: BOARD, HOUSE|waiting for: HOUSE, BOARD/);
    await expect(k.exec.startOperation(orderId, 'QC', k.actor, 'r-qc-early', m)).rejects.toThrow(/waiting for: ASM/);
    run.BOARD = (await k.exec.startOperation(orderId, 'BOARD', k.actor, 'r-board', m)).id;
    run.HOUSE = (await k.exec.startOperation(orderId, 'HOUSE', k.actor, 'r-house', m)).id; // parallel with BOARD
    await expect(k.exec.startOperation(orderId, 'BOARD', k.actor, 'r-board-2', m)).rejects.toThrow(/already has a run in progress/);
    const view = await k.exec.getExecution(orderId, m);
    expect(view.operations.find((o) => o.code === 'BOARD')!.status).toBe('running');
    expect(view.operations.find((o) => o.code === 'ASM')!.status).toBe('pending');
    expect(view.operations.find((o) => o.code === 'ASM')!.blockedBy.sort()).toEqual(['BOARD', 'HOUSE']);
  });

  it('S4-5 consumption is bounded: by the operation plan, by the chosen alternate, by what was issued, and by what earlier operations yielded', async () => {
    const m = await k.mgr();
    await expect(k.exec.recordConsumption(orderId, run.BOARD, p.chip, 41, k.actor, 'c-over', m)).rejects.toThrow(/plans 40/);
    await expect(k.exec.recordConsumption(orderId, run.BOARD, p.wireB, 1, k.actor, 'c-wireb', m)).rejects.toThrow(/does not consume/); // not the chosen alternative
    await expect(k.exec.recordConsumption(orderId, run.BOARD, p.shell, 1, k.actor, 'c-shell', m)).rejects.toThrow(/does not consume/); // belongs to HOUSE
    await expect(k.exec.recordYield(orderId, run.BOARD, p.lamp, 1, k.actor, 'y-wrong', m)).rejects.toThrow(/does not yield/);
    await expect(k.exec.recordYield(orderId, run.BOARD, p.pcb, 11, k.actor, 'y-over', m)).rejects.toThrow(/plans 10/);
    const a = await k.exec.recordConsumption(orderId, run.BOARD, p.chip, 40, k.actor, 'c-chip', m);
    const a2 = await k.exec.recordConsumption(orderId, run.BOARD, p.chip, 40, k.actor, 'c-chip', m); // retry, same request
    expect(a2.id).toBe(a.id);
    expect(Number(a.valueBase)).toBeCloseTo(80, 4); // 40 x 2.00 at the WIP unit cost
    await k.exec.recordConsumption(orderId, run.BOARD, p.wireA, 20, k.actor, 'c-wire', m);
    await expect(k.exec.recordConsumption(orderId, run.BOARD, p.chip, 1, k.actor, 'c-chip-3', m)).rejects.toThrow(/plans 40|already consumed|only 40/);
    expect((await k.q(`SELECT count(*)::int AS n FROM "mfg_operation_flows" WHERE "runId" = $1 AND "direction" = 'in'`, [run.BOARD]))[0].n).toBe(2); // the retry created nothing
  });

  it('S4-6 completing a run stamps its yield with the material value it consumed; the operation then holds no WIP and the intermediate carries the value', async () => {
    const m = await k.mgr();
    await k.exec.recordYield(orderId, run.BOARD, p.pcb, 10, k.actor, 'y-pcb', m);
    const mid = await k.exec.getExecution(orderId, m);
    expect(Number(mid.operations.find((o) => o.code === 'BOARD')!.wipValueBase)).toBeCloseTo(110, 4); // consumed, run not completed yet: the value is inside the operation
    await k.exec.completeRun(orderId, run.BOARD, k.actor, m);
    await k.exec.completeRun(orderId, run.BOARD, k.actor, m); // idempotent
    const done = await k.exec.getExecution(orderId, m);
    expect(Number(done.operations.find((o) => o.code === 'BOARD')!.wipValueBase)).toBeCloseTo(0, 4);
    expect(done.intermediateOnHand).toEqual([expect.objectContaining({ productId: p.pcb, quantity: 10, valueBase: '110.0000' })]);
  });

  it('S4-7 an intermediate cannot be consumed before it was yielded; once both branches are done the join runs and consumes at the carried value', async () => {
    const m = await k.mgr();
    await k.exec.recordConsumption(orderId, run.HOUSE, p.shell, 10, k.actor, 'c-shell', m);
    await k.exec.recordYield(orderId, run.HOUSE, p.body, 10, k.actor, 'y-body', m);
    await k.exec.completeRun(orderId, run.HOUSE, k.actor, m);
    run.ASM = (await k.exec.startOperation(orderId, 'ASM', k.actor, 'r-asm', m)).id;
    await expect(k.exec.recordConsumption(orderId, run.ASM, p.pcb, 11, k.actor, 'a-over', m)).rejects.toThrow(/plans 10/);
    const pcb = await k.exec.recordConsumption(orderId, run.ASM, p.pcb, 10, k.actor, 'a-pcb', m);
    const body = await k.exec.recordConsumption(orderId, run.ASM, p.body, 10, k.actor, 'a-body', m);
    expect(Number(pcb.valueBase)).toBeCloseTo(110, 4);
    expect(Number(body.valueBase)).toBeCloseTo(60, 4);
    await k.exec.recordYield(orderId, run.ASM, p.lamp, 10, k.actor, 'y-lamp', m);
    await k.exec.completeRun(orderId, run.ASM, k.actor, m);
    const v = await k.exec.getExecution(orderId, m);
    expect(v.intermediateOnHand).toHaveLength(0); // everything made was consumed
    const asm = v.operations.find((o) => o.code === 'ASM')!;
    expect(asm.yielded[0]).toMatchObject({ productId: p.lamp, quantity: 10, valueBase: '170.0000' });
    expect(Number(v.totals.rawConsumedValueBase)).toBeCloseTo(170, 4); // equals the order WIP: nothing leaked, nothing invented
    expect(Number(v.totals.operationWipValueBase)).toBeCloseTo(0, 4);
  });

  it('S4-8 the optional inspection is repeatable up to its limit and never blocks; a mandatory operation cannot be skipped', async () => {
    const m = await k.mgr();
    await expect(k.exec.skipOperation(orderId, 'ASM', k.actor, 'sk', m)).rejects.toThrow(/mandatory/);
    const r1 = await k.exec.startOperation(orderId, 'QC', k.actor, 'qc-1', m);
    await expect(k.exec.startOperation(orderId, 'QC', k.actor, 'qc-1b', m)).rejects.toThrow(/already has a run in progress/);
    await expect(k.wo.complete(orderId, k.actor, m)).rejects.toThrow(/QC \(still running\)|WIP balance/); // a running operation blocks closing
    await k.exec.completeRun(orderId, r1.id, k.actor, m);
    const r2 = await k.exec.startOperation(orderId, 'QC', k.actor, 'qc-2', m);
    await k.exec.completeRun(orderId, r2.id, k.actor, m);
    await expect(k.exec.startOperation(orderId, 'QC', k.actor, 'qc-3', m)).rejects.toThrow(/permitted run/);
    expect((await k.exec.getExecution(orderId, m)).operations.find((o) => o.code === 'QC')).toMatchObject({ status: 'completed', runs: 2 });
  });

  it('S4-9 the unchanged order lifecycle closes it: output takes the whole pooled value, WIP and GL return to zero, the lamp is in stock', async () => {
    const m = await k.mgr();
    // CTO D1: the basic single-output receipt is refused on a process-bound order and points at the multi-output receipt; nothing is posted by the refusal
    const movements0 = (await k.q(`SELECT count(*)::int AS n FROM "stock_movements"`))[0].n;
    await expect(k.wo.finishedGoodsOutput(orderId, 10, k.actor, 'out-basic', m)).rejects.toThrow(/bound to a process definition.*multi-output receipt/);
    expect((await k.q(`SELECT count(*)::int AS n FROM "stock_movements"`))[0].n).toBe(movements0);
    await k.wo.receiveProcessOutputs(orderId, 10, k.actor, 'out-all', m);
    await k.flush();
    await k.wo.complete(orderId, k.actor, m);
    await k.flush();
    expect(await k.wo.computeWipValue(orderId, m)).toBeCloseTo(0, 4);
    expect(await k.glBalance('1150')).toBeCloseTo(0, 4);
    expect(await k.onHand(k.warehouseId, p.lamp)).toBe(10);
    expect(await k.onHand(wip, p.chip)).toBe(0); // the order's WIP warehouse is empty of components
    expect(await k.onHand(wip, p.lamp)).toBe(0);
  });

  it('S4-10 a mandatory operation not run blocks closing (second order), and the Basic Profile is untouched', async () => {
    const m = await k.mgr();
    const o2 = await k.wo.createProcessWorkOrder(p.lamp, 2, k.warehouseId, choices(p.wireA), k.actor, m);
    await k.wo.release(o2.id, k.actor, m);
    await k.wo.materialIssue(o2.id, p.chip, 8, k.actor, 'i2-chip', m);
    await k.flush();
    await expect(k.wo.complete(o2.id, k.actor, m)).rejects.toThrow(/BOARD \(not completed\)|WIP balance/);
    // Basic Profile: a flat-BOM order is not process-bound and the process endpoints refuse it
    await k.bom.defineBom(p.basic, [{ componentProductId: p.basicC, quantityPerUnit: 1 }], k.actor, m);
    const b = await k.wo.createWorkOrder(p.basic, 3, k.warehouseId, k.actor, m);
    expect(b.processVersionId).toBeNull();
    await k.wo.release(b.id, k.actor, m);
    await expect(k.exec.getExecution(b.id, m)).rejects.toThrow(/not process-bound/);
    await k.wo.materialIssue(b.id, p.basicC, 3, k.actor, 'ib', m);
    await k.wo.finishedGoodsOutput(b.id, 3, k.actor, 'ob', m);
    await k.flush();
    await k.wo.complete(b.id, k.actor, m);
    expect(await k.wo.getWorkOrderState(b.id, m)).toBe('completed');
  });

  it('S4-12 an OPTIONAL operation in a chain is transparent but never lets the next one jump the line: A -> optional B -> C keeps C behind A (view and start gate agree)', async () => {
    const m = await k.mgr();
    p.chain = await k.product('S4-CHAIN', 'Chain item');
    const v = await k.processes.createDraft(
      p.chain,
      {
        name: 'Chain with an optional middle',
        operations: [
          { code: 'ONE', name: 'First', operationTypeCode: 'transform', sequenceNo: 10 },
          { code: 'TWO', name: 'Optional middle', operationTypeCode: 'transform', sequenceNo: 20, optional: true },
          { code: 'THREE', name: 'Last', operationTypeCode: 'transform', sequenceNo: 30 },
        ],
        edges: [{ from: 'ONE', to: 'TWO' }, { from: 'TWO', to: 'THREE' }],
        inputs: [{ operationCode: 'ONE', componentProductId: p.basicC, quantityPerUnit: 1 }],
        outputs: [{ operationCode: 'THREE', productId: p.chain, quantityPerUnit: 1, role: 'good' }],
      },
      k.actor,
      m,
    );
    await k.processes.activate(v.version.id, k.actor, m);
    const o = await k.wo.createProcessWorkOrder(p.chain, 2, k.warehouseId, null, k.actor, m);
    await k.wo.release(o.id, k.actor, m);
    await k.wo.materialIssue(o.id, p.basicC, 2, k.actor, 'chain-iss', m);
    const status = async (code: string) => (await k.exec.getExecution(o.id, m)).operations.find((x) => x.code === code)!;
    // the view says THREE waits for ONE (not "ready" because TWO is optional), and the start gate refuses with the same blocker
    expect(await status('THREE')).toMatchObject({ status: 'pending', blockedBy: ['ONE'] });
    await expect(k.exec.startOperation(o.id, 'THREE', k.actor, 'th-early', m)).rejects.toThrow(/waiting for: ONE/);
    const r1 = await k.exec.startOperation(o.id, 'ONE', k.actor, 'one-1', m);
    await k.exec.recordConsumption(o.id, r1.id, p.basicC, 2, k.actor, 'one-c', m);
    await k.exec.completeRun(o.id, r1.id, k.actor, m);
    // ONE is done: THREE is ready WITHOUT running the optional TWO; TWO itself is ready to run or skip
    expect(await status('THREE')).toMatchObject({ status: 'ready', blockedBy: [] });
    expect(await status('TWO')).toMatchObject({ status: 'ready' });
    const r3 = await k.exec.startOperation(o.id, 'THREE', k.actor, 'th-1', m);
    expect(r3.status).toBe('running');
  });

  it('S4-11 Company B (the witness) holds no process execution data', async () => {
    const b = await k.h.connections.getDataSource(k.h.companyBId);
    for (const t of ['mfg_operation_runs', 'mfg_operation_flows', 'mfg_process_versions']) expect((await b.query(`SELECT count(*)::int AS n FROM "${t}"`))[0].n).toBe(0);
  });
});
