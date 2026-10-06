import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { WorkOrderService } from '../application/work-order.service';
import { RoutingService } from '../application/routing.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { BomService } from '../../commerce/application/bom.service';
import { ProductsService } from '../../commerce/application/products.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';
import { WorkOrder } from '../infrastructure/work-order.entity';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `work-order.controller.ts`'s reads/writes are
 * genuinely Company-scoped — two real, separately provisioned Company
 * databases, each with its own warehouse, finished product, component,
 * BOM and stock. `WorkOrderService`, `BomService` and `ProductsService` are
 * built with an **inert ambient DataSource**, so a call that missed the
 * Company manager would crash instead of silently using the wrong database.
 *
 * The lifecycle exercised is the real one: create → release (BOM snapshot,
 * reservations, auto-created WIP sub-warehouse) → material issue (valued
 * ledger movements warehouse → WIP) → hold. The F08 cost engine is a stub
 * that **throws unless handed the Company manager** (its own isolation is
 * proven by §22); it also derives each Company's WIP value from that
 * Company's own work orders so a leak would show in `wipValue`.
 */
describe('WorkOrderController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: WorkOrderService;
  let bom: BomService;
  let inventory: InventoryService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { warehouseId: string; finishedId: string; componentId: string; workOrderId: string }> = {
    A: { warehouseId: '', finishedId: '', componentId: '', workOrderId: '' },
    B: { warehouseId: '', finishedId: '', componentId: '', workOrderId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', code: string, stock: number) {
    const ds = await h.connections.getDataSource(companyId);
    const warehouseId = randomUUID();
    const finishedId = randomUUID();
    const componentId = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Planner',
      `iso-plan-${companyId}@test.local`,
    ]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,$2,$3,'active','main')`, [warehouseId, `WH-${code}`, `${code} Warehouse`]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'50.00','active')`, [finishedId, `FIN-${code}`, `${code} Finished`]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'5.00','active')`, [componentId, `COMP-${code}`, `${code} Component`]);
    await bom.defineBom(finishedId, [{ componentProductId: componentId, quantityPerUnit: 2 }], actorUserId, ds.manager);
    await inventory.recordMovement(warehouseId, componentId, stock, 'receipt', 'seed', 'seed', actorUserId, ds.manager);
    seeded[key] = { warehouseId, finishedId, componentId, workOrderId: '' };
  }

  async function onHand(companyId: string, warehouseId: string, productId: string): Promise<number> {
    const ds = await h.connections.getDataSource(companyId);
    const rows: Array<{ sum: string | null }> = await ds.query(`SELECT SUM("quantity") AS sum FROM "stock_movements" WHERE "warehouseId" = $1 AND "productId" = $2`, [warehouseId, productId]);
    return Number(rows[0].sum ?? 0);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'wo_isolation', extraCompanyTags: ['sales', 'inventory', 'finance', 'accounting', 'manufacturing'] });

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const products = new ProductsService(inert, audit, inert);
    bom = new BomService(inert, audit, products);
    inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, inert, undefined);

    // Throws unless handed the Company manager; WIP value derived from that Company's own work orders.
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
      getValuedOnHandTotal: async (_d?: string, manager?: EntityManager) => {
        const rows: Array<{ wipWarehouseId: string }> = await need(manager).query(`SELECT "wipWarehouseId" FROM "work_orders" WHERE "wipWarehouseId" IS NOT NULL`);
        return rows.map((r) => ({ warehouseId: r.wipWarehouseId, totalValueBase: '20.0000' }));
      },
    } as unknown as InventoryValuationContract;

    service = new WorkOrderService(inert, inventory, numbering, processEngine, audit, events, bom, valuation, new RoutingService(inert, audit, products));

    await seedCompanyData(h.companyAId, 'A', 'A', 100);
    await seedCompanyData(h.companyBId, 'B', 'B', 100);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("createWorkOrder for Company A writes inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const wo = await service.createWorkOrder(seeded.A.finishedId, 5, seeded.A.warehouseId, actorUserId, dsA.manager);
    seeded.A.workOrderId = wo.id;
    expect(await dsA.getRepository(WorkOrder).findOne({ where: { id: wo.id } })).toBeTruthy();
  });

  it("createWorkOrder for Company B writes independently in Company B's own database", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const wo = await service.createWorkOrder(seeded.B.finishedId, 3, seeded.B.warehouseId, actorUserId, dsB.manager);
    seeded.B.workOrderId = wo.id;
    expect(await dsB.getRepository(WorkOrder).findOne({ where: { id: seeded.A.workOrderId } })).toBeNull();
  });

  it("release for Company A snapshots A's BOM, reserves A's stock and creates the WIP sub-warehouse only in A's database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const released = await service.release(seeded.A.workOrderId, actorUserId, dsA.manager);
    expect(released.wipWarehouseId).toBeTruthy();
    expect(await service.getWorkOrderState(seeded.A.workOrderId, dsA.manager)).toBe('released');

    const components = await service.getWorkOrderComponents(seeded.A.workOrderId, dsA.manager);
    expect(components.map((c) => c.quantityRequired)).toEqual([10]); // 2 per unit x 5 planned
    const wipA: Array<{ id: string }> = await dsA.query(`SELECT id FROM "warehouses" WHERE "kind" = 'operational'`);
    const wipB: Array<{ id: string }> = await dsB.query(`SELECT id FROM "warehouses" WHERE "kind" = 'operational'`);
    expect(wipA).toHaveLength(1);
    expect(wipB).toHaveLength(0);
    const reservedA: Array<{ sum: string | null }> = await dsA.query(`SELECT SUM("quantity") AS sum FROM "stock_reservations" WHERE "referenceType" = 'WORK_ORDER'`);
    expect(Number(reservedA[0].sum)).toBe(10);
    expect(await service.getWorkOrderState(seeded.B.workOrderId, dsB.manager)).toBe('draft');
  });

  it("materialIssue for Company A moves A's stock warehouse -> WIP in A's ledger only; B's stock is untouched", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await service.materialIssue(seeded.A.workOrderId, seeded.A.componentId, 4, actorUserId, 'req-iso-1', dsA.manager);

    expect(await service.getWorkOrderState(seeded.A.workOrderId, dsA.manager)).toBe('in_progress');
    expect(await onHand(h.companyAId, seeded.A.warehouseId, seeded.A.componentId)).toBe(96);
    const wo = await service.getWorkOrderOrThrow(seeded.A.workOrderId, dsA.manager);
    expect(await onHand(h.companyAId, wo.wipWarehouseId!, seeded.A.componentId)).toBe(4);
    expect(await onHand(h.companyBId, seeded.B.warehouseId, seeded.B.componentId)).toBe(100);
  });

  it("hold for Company A moves only A's work order to on_hold; B's stays draft", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    await service.hold(seeded.A.workOrderId, actorUserId, dsA.manager);
    expect(await service.getWorkOrderState(seeded.A.workOrderId, dsA.manager)).toBe('on_hold');
    expect(await service.getWorkOrderState(seeded.B.workOrderId, dsB.manager)).toBe('draft');
  });

  it('listWorkOrdersWithSummary via Company A shows only A\'s work order (WIP 20.0000); via Company B only B\'s (no WIP warehouse yet -> 0.0000)', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const a = await service.listWorkOrdersWithSummary(dsA.manager);
    const b = await service.listWorkOrdersWithSummary(dsB.manager);
    expect(a.map((w) => [w.id, w.state, w.wipValue])).toEqual([[seeded.A.workOrderId, 'on_hold', '20.0000']]);
    expect(b.map((w) => [w.id, w.state, w.wipValue])).toEqual([[seeded.B.workOrderId, 'draft', '0.0000']]);
  });

  it("getWorkOrderOrThrow / release / materialIssue of Company A's work order through Company B's manager is rejected (A→B DENY)", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(service.getWorkOrderOrThrow(seeded.A.workOrderId, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(service.release(seeded.A.workOrderId, actorUserId, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(service.materialIssue(seeded.A.workOrderId, seeded.A.componentId, 1, actorUserId, 'req-iso-x', dsB.manager)).rejects.toThrow(/not found/i);
  });

  it("Test F — resolving Company A's work orders never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listWorkOrdersWithSummary(dsA.manager);
      await service.getWorkOrderOrThrow(seeded.A.workOrderId, dsA.manager);
      await service.getFinancialTrail(seeded.A.workOrderId, dsA.manager);
      await service.getAuditTrail(seeded.A.workOrderId, dsA.manager);
    });
  });
});
