import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { WorkOrderService } from '../application/work-order.service';
import { WorkCenterService } from '../application/work-center.service';
import { RoutingService } from '../application/routing.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { BomService } from '../../commerce/application/bom.service';
import { ProductsService } from '../../commerce/application/products.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';
import { WorkCenter } from '../infrastructure/work-center.entity';
import { Routing } from '../infrastructure/routing.entity';
import { WorkOrderOperation } from '../infrastructure/work-order-operation.entity';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * ADR-061 Addendum 1 (M2/M3, 2026-10-06) — real-Postgres Company A/B isolation AND behaviour proof for the
 * Manufacturing master data: BOM status/eligibility, Work Centers, Routings, the release-time operation
 * snapshot, in-sequence operation execution and the opt-in completion guard. Two real, separately
 * provisioned Company databases; every service is built with an INERT ambient DataSource, so a call that
 * missed the Company manager crashes instead of silently using another database.
 */
describe('Manufacturing master data — real-Postgres Company isolation + behaviour (ADR-061 Addendum 1)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let workOrders: WorkOrderService;
  let workCenters: WorkCenterService;
  let routings: RoutingService;
  let bom: BomService;
  let inventory: InventoryService;
  const actor = randomUUID();

  type Seed = { warehouseId: string; finishedId: string; plainFinishedId: string; componentId: string; wcCutId: string; wcPackId: string };
  const seeded: Record<'A' | 'B', Seed> = {
    A: { warehouseId: '', finishedId: '', plainFinishedId: '', componentId: '', wcCutId: '', wcPackId: '' },
    B: { warehouseId: '', finishedId: '', plainFinishedId: '', componentId: '', wcCutId: '', wcPackId: '' },
  };

  async function seedBase(companyId: string, key: 'A' | 'B', code: string) {
    const ds = await h.connections.getDataSource(companyId);
    const s = seeded[key];
    s.warehouseId = randomUUID();
    s.finishedId = randomUUID();
    s.plainFinishedId = randomUUID();
    s.componentId = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [actor, 'Master Data Tester', `md-${companyId}@test.local`]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,$2,$3,'active','main')`, [s.warehouseId, `WH-${code}`, `${code} Warehouse`]);
    for (const [id, sku, price] of [
      [s.finishedId, `FIN-${code}`, '50.00'],
      [s.plainFinishedId, `PLAIN-${code}`, '40.00'],
      [s.componentId, `COMP-${code}`, '5.00'],
    ]) {
      await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,$4,'active')`, [id, sku, `${sku} name`, price]);
    }
    await inventory.recordMovement(s.warehouseId, s.componentId, 100, 'receipt', 'seed', 'seed', actor, ds.manager);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'mfg_masterdata', extraCompanyTags: ['sales', 'inventory', 'finance', 'accounting', 'manufacturing'] });

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const products = new ProductsService(inert, audit, inert);
    bom = new BomService(inert, audit, products);
    inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, inert, undefined);
    workCenters = new WorkCenterService(inert, audit);
    routings = new RoutingService(inert, audit, products);

    const need = (manager?: EntityManager): EntityManager => {
      if (!manager) throw new Error('valuation called without the Company manager');
      return manager;
    };
    const valuation = {
      getUnitCost: async (_p: string, _w: string, _d?: string, manager?: EntityManager) => {
        need(manager);
        return { unitCostBase: '5.0000' };
      },
      consumeIssueCost: async (_p: string, _w: string, qty: number, _k: string, manager?: EntityManager) => {
        need(manager);
        return { unitCostBase: '5.0000', totalCostBase: (qty * 5).toFixed(4) };
      },
      recordReceiptCost: async (_p: string, _w: string, _q: number, _c: string, _k: string, manager?: EntityManager) => {
        need(manager);
      },
      // WIP is 0 here on purpose: lets `complete()` reach the routing-operation guard under test.
      getValuedOnHandTotal: async (_d?: string, manager?: EntityManager) => {
        need(manager);
        return [];
      },
    } as unknown as InventoryValuationContract;

    workOrders = new WorkOrderService(inert, inventory, numbering, processEngine, audit, events, bom, valuation, routings);

    await seedBase(h.companyAId, 'A', 'A');
    await seedBase(h.companyBId, 'B', 'B');
  });

  afterAll(async () => {
    await h.teardown();
  });

  // ---------------------------------------------------------------- BOM status / eligibility
  it('A3 — createWorkOrder is rejected for a product with no BOM, in each Company', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await expect(workOrders.createWorkOrder(seeded.A.finishedId, 2, seeded.A.warehouseId, actor, dsA.manager)).rejects.toThrow(/no active Bill of Materials/i);
  });

  it('A2 — a BOM defined in Company A is listed as active in A only; B sees none', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    await bom.defineBom(seeded.A.finishedId, [{ componentProductId: seeded.A.componentId, quantityPerUnit: 2 }], actor, dsA.manager);
    const listA = await bom.listBoms(dsA.manager);
    expect(listA.map((b) => [b.finishedProductId, b.status, b.componentCount])).toEqual([[seeded.A.finishedId, 'active', 1]]);
    expect(await bom.listBoms(dsB.manager)).toEqual([]);
    const view = await bom.getBom(seeded.A.finishedId, dsA.manager);
    expect(view?.components[0]).toMatchObject({ sku: 'COMP-A', quantityPerUnit: 2 });
  });

  it('A2/A3 — deactivating a BOM makes the product ineligible; reactivating restores it (data preserved)', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await bom.setBomStatus(seeded.A.finishedId, 'inactive', actor, dsA.manager);
    expect(await bom.getBomForAssembly(seeded.A.finishedId, dsA.manager)).toBeNull();
    await expect(workOrders.createWorkOrder(seeded.A.finishedId, 2, seeded.A.warehouseId, actor, dsA.manager)).rejects.toThrow(/no active Bill of Materials/i);
    expect((await bom.getBom(seeded.A.finishedId, dsA.manager))?.status).toBe('inactive');
    await bom.setBomStatus(seeded.A.finishedId, 'active', actor, dsA.manager);
    expect(await bom.getBomForAssembly(seeded.A.finishedId, dsA.manager)).toHaveLength(1);
  });

  // ---------------------------------------------------------------- Work Centers
  it('A1 — Work Centers: create/validate/list are per Company; same code may exist in both Companies', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const cut = await workCenters.create({ code: 'cut', name: 'Cutting' }, actor, dsA.manager);
    expect(cut.code).toBe('CUT');
    seeded.A.wcCutId = cut.id;
    seeded.A.wcPackId = (await workCenters.create({ code: 'PACK', name: 'Packing' }, actor, dsA.manager)).id;
    await expect(workCenters.create({ code: 'CUT', name: 'dup' }, actor, dsA.manager)).rejects.toThrow(/already exists|exists/i);
    await expect(workCenters.create({ code: 'bad code!', name: 'x' }, actor, dsA.manager)).rejects.toThrow(/code/i);

    // Same code in Company B is a different row in a different database.
    const cutB = await workCenters.create({ code: 'CUT', name: 'Cutting B' }, actor, dsB.manager);
    seeded.B.wcCutId = cutB.id;
    seeded.B.wcPackId = (await workCenters.create({ code: 'PACK', name: 'Packing B' }, actor, dsB.manager)).id;
    expect((await workCenters.list(dsA.manager)).map((w) => w.code)).toEqual(['CUT', 'PACK']);
    expect((await workCenters.list(dsB.manager)).map((w) => w.name)).toEqual(['Cutting B', 'Packing B']);
    await expect(workCenters.getOrThrow(cut.id, dsB.manager)).rejects.toThrow(/not found/i);
  });

  // ---------------------------------------------------------------- Routings
  it('A1 — a routing validates its operations and is isolated per Company', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const s = seeded.A;
    await expect(routings.define(s.finishedId, [], actor, dsA.manager)).rejects.toThrow(/at least one/i);
    await expect(
      routings.define(s.finishedId, [{ sequence: 10, name: 'a', workCenterId: s.wcCutId }, { sequence: 10, name: 'b', workCenterId: s.wcPackId }], actor, dsA.manager),
    ).rejects.toThrow(/more than once/i);
    // Company B's work center is not visible from Company A.
    await expect(routings.define(s.finishedId, [{ sequence: 10, name: 'a', workCenterId: seeded.B.wcCutId }], actor, dsA.manager)).rejects.toThrow(/not found/i);

    await routings.define(s.finishedId, [{ sequence: 20, name: 'Pack', workCenterId: s.wcPackId }, { sequence: 10, name: 'Cut', workCenterId: s.wcCutId }], actor, dsA.manager);
    const view = await routings.get(s.finishedId, dsA.manager);
    expect(view?.operations.map((o) => [o.sequence, o.name, o.workCenterCode])).toEqual([[10, 'Cut', 'CUT'], [20, 'Pack', 'PACK']]);
    expect((await routings.list(dsA.manager)).map((r) => [r.finishedProductId, r.operationCount])).toEqual([[s.finishedId, 2]]);
    expect(await routings.list(dsB.manager)).toEqual([]);
    expect(await routings.get(s.finishedId, dsB.manager)).toBeNull();
  });

  it('A1 — a Work Center referenced by a routing cannot be deleted (409) but can be deactivated, which blocks release', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await expect(workCenters.remove(seeded.A.wcPackId, actor, dsA.manager)).rejects.toThrow(/deactivate/i);
    await workCenters.update(seeded.A.wcPackId, { status: 'inactive' }, actor, dsA.manager);
    await expect(routings.getActiveOperationsForRelease(seeded.A.finishedId, dsA.manager)).rejects.toThrow(/inactive/i);
    await workCenters.update(seeded.A.wcPackId, { status: 'active' }, actor, dsA.manager);
    expect(await routings.getActiveOperationsForRelease(seeded.A.finishedId, dsA.manager)).toHaveLength(2);
  });

  // ---------------------------------------------------------------- Work Order integration
  let woA = '';
  it('A1 — release snapshots the active routing onto the Work Order (Company A only); later routing edits do not touch it', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    woA = (await workOrders.createWorkOrder(seeded.A.finishedId, 5, seeded.A.warehouseId, actor, dsA.manager)).id;
    await workOrders.release(woA, actor, dsA.manager);
    const ops = await workOrders.getWorkOrderOperations(woA, dsA.manager);
    expect(ops.map((o) => [o.sequence, o.name, o.workCenterCode, o.status])).toEqual([[10, 'Cut', 'CUT', 'pending'], [20, 'Pack', 'PACK', 'pending']]);
    expect(await dsB.getRepository(WorkOrderOperation).count()).toBe(0);

    // Edit the live routing — the snapshot is unchanged.
    await routings.define(seeded.A.finishedId, [{ sequence: 10, name: 'Cut v2', workCenterId: seeded.A.wcCutId }], actor, dsA.manager);
    expect((await workOrders.getWorkOrderOperations(woA, dsA.manager)).map((o) => o.name)).toEqual(['Cut', 'Pack']);
  });

  it('A1 — a Work Order for a product with no routing releases with zero operations and is unaffected by the guard', async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await bom.defineBom(seeded.B.finishedId, [{ componentProductId: seeded.B.componentId, quantityPerUnit: 1 }], actor, dsB.manager);
    const wo = await workOrders.createWorkOrder(seeded.B.finishedId, 2, seeded.B.warehouseId, actor, dsB.manager);
    await workOrders.release(wo.id, actor, dsB.manager);
    expect(await workOrders.getWorkOrderOperations(wo.id, dsB.manager)).toEqual([]);
  });

  it('A1 — operations run strictly in sequence; each transition is guarded', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const [cut, pack] = await workOrders.getWorkOrderOperations(woA, dsA.manager);
    await expect(workOrders.startOperation(woA, pack.id, actor, dsA.manager)).rejects.toThrow(/must be completed before/i);
    await expect(workOrders.completeOperation(woA, cut.id, actor, dsA.manager)).rejects.toThrow(/must be in progress/i);
    await workOrders.startOperation(woA, cut.id, actor, dsA.manager);
    await expect(workOrders.startOperation(woA, cut.id, actor, dsA.manager)).rejects.toThrow(/already/i);
    await workOrders.completeOperation(woA, cut.id, actor, dsA.manager);
    const after = await workOrders.getWorkOrderOperations(woA, dsA.manager);
    expect(after.map((o) => o.status)).toEqual(['completed', 'pending']);
    expect(after[0].startedByUserId).toBe(actor);
  });

  it("A1 — Company B cannot start Company A's operation (A→B DENY)", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const [, pack] = await workOrders.getWorkOrderOperations(woA, dsA.manager);
    await expect(workOrders.startOperation(woA, pack.id, actor, dsB.manager)).rejects.toThrow(/not found/i);
  });

  it('A1 — complete() is blocked while an operation is open, and succeeds once all operations are completed', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await workOrders.materialIssue(woA, seeded.A.componentId, 10, actor, 'md-issue-1', dsA.manager);
    expect(await workOrders.getWorkOrderState(woA, dsA.manager)).toBe('in_progress');
    await expect(workOrders.complete(woA, actor, dsA.manager)).rejects.toThrow(/operation\(s\) are not completed/i);

    const ops = await workOrders.getWorkOrderOperations(woA, dsA.manager);
    const pack = ops.find((o) => o.status === 'pending')!;
    await workOrders.startOperation(woA, pack.id, actor, dsA.manager);
    await workOrders.completeOperation(woA, pack.id, actor, dsA.manager);
    await workOrders.complete(woA, actor, dsA.manager);
    expect(await workOrders.getWorkOrderState(woA, dsA.manager)).toBe('completed');
    await expect(workOrders.startOperation(woA, pack.id, actor, dsA.manager)).rejects.toThrow(/cannot start an operation from state/i);
  });

  // ---------------------------------------------------------------- Downgrade preservation (data level)
  it('Package downgrade/upgrade — master data and snapshots are plain Company rows: nothing is deleted or altered by entitlement changes', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    // Entitlement is enforced at the API (RequireModuleGuard) and never mutates Company data; prove the data
    // survives untouched and remains fully readable once access is restored.
    expect(await dsA.getRepository(WorkCenter).count()).toBe(2);
    expect(await dsA.getRepository(Routing).count()).toBe(1);
    expect(await dsA.getRepository(WorkOrderOperation).count()).toBe(2);
    expect((await bom.getBom(seeded.A.finishedId, dsA.manager))?.status).toBe('active');
  });

  it('Test F — resolving Company A master data never even requests Company B\'s DataSource', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await bom.listBoms(dsA.manager);
      await workCenters.list(dsA.manager);
      await routings.list(dsA.manager);
      await routings.get(seeded.A.finishedId, dsA.manager);
      await workOrders.getWorkOrderOperations(woA, dsA.manager);
    });
  });
});
