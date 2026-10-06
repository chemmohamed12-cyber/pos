import { randomUUID } from 'crypto';
import { FulfillmentService } from '../application/fulfillment.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { FulfillmentOrder } from '../infrastructure/fulfillment-order.entity';
import { PickTask } from '../infrastructure/pick-task.entity';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `fulfillment.controller.ts`'s reads/writes are
 * genuinely Company-scoped after this retrofit — two real, separately
 * provisioned Company databases, each with its own distinct Fulfillment
 * Order, never mocked.
 *
 * `createFulfillmentOrder` is the sharpest proof available here: it
 * transitively calls `InventoryService.getActiveReservationsForOrder`,
 * `NumberingService.getNextNumber`, `ProcessEngineService.start`, and
 * `AuditService.record` (all real, constructed for this test) — the same
 * manager-threading chain this retrofit added throughout
 * `FulfillmentService`.
 */
describe('FulfillmentController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: FulfillmentService;
  const salesOrderIdA = `SO-ISO-A-${randomUUID()}`;
  const salesOrderIdB = `SO-ISO-B-${randomUUID()}`;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'fulfillment_isolation', extraCompanyTags: ['sales', 'inventory'] });

    // `createFulfillmentOrder` derives everything from `StockReservation`
    // rows — seed one directly per Company (the reservation's own creation
    // path, `InventoryService.reserveStock`, is Inventory's own retrofit
    // to prove, not Fulfillment's; this test proves Fulfillment's own
    // Company-scoped read/write of that data).
    for (const [companyId, salesOrderId] of [
      [h.companyAId, salesOrderIdA],
      [h.companyBId, salesOrderIdB],
    ] as const) {
      const ds = await h.connections.getDataSource(companyId);
      const warehouseId = randomUUID();
      const productId = randomUUID();
      await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,'WH-MAIN','Main Warehouse','active','main')`, [
        warehouseId,
      ]);
      await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice") VALUES ($1,'SKU-ISO','Isolation Test Product','10.00')`, [
        productId,
      ]);
      await ds.query(
        `INSERT INTO "stock_reservations" ("id","warehouseId","productId","quantity","salesOrderId","status") VALUES ($1,$2,$3,3,$4,'active')`,
        [randomUUID(), warehouseId, productId, salesOrderId],
      );
    }

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, inert, undefined);
    service = new FulfillmentService(h.controlPlane, processEngine, inert, audit, events, inventory, numbering);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("createFulfillmentOrder for Company A creates its Fulfillment Order + Pick Task inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const { fulfillmentOrder, pickTask } = await service.createFulfillmentOrder(salesOrderIdA, randomUUID(), dsA.manager);

    expect(fulfillmentOrder.salesOrderId).toBe(salesOrderIdA);
    expect(fulfillmentOrder.orderNumber).toBeTruthy();
    expect(pickTask.fulfillmentOrderId).toBe(fulfillmentOrder.id);

    const row = await dsA.getRepository(FulfillmentOrder).findOne({ where: { id: fulfillmentOrder.id } });
    expect(row).toBeTruthy();
    const pickRow = await dsA.getRepository(PickTask).findOne({ where: { id: pickTask.id } });
    expect(pickRow).toBeTruthy();
  });

  it("createFulfillmentOrder for Company B creates independently in Company B's own database — no leakage of Company A's order", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const { fulfillmentOrder } = await service.createFulfillmentOrder(salesOrderIdB, randomUUID(), dsB.manager);
    expect(fulfillmentOrder.salesOrderId).toBe(salesOrderIdB);

    const rowInB = await dsB.getRepository(FulfillmentOrder).findOne({ where: { salesOrderId: salesOrderIdA } });
    expect(rowInB).toBeNull();
  });

  it("listFulfillmentOrders via Company A resolves only Company A's own Fulfillment Order — never Company B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const orders = await service.listFulfillmentOrders(dsA.manager);
    expect(orders.map((o) => o.salesOrderId)).toEqual([salesOrderIdA]);
  });

  it("listFulfillmentOrders via Company B resolves only Company B's own Fulfillment Order — no leakage of Company A's data", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const orders = await service.listFulfillmentOrders(dsB.manager);
    expect(orders.map((o) => o.salesOrderId)).toEqual([salesOrderIdB]);
  });

  it("Test F — resolving Company A's Fulfillment Orders never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listFulfillmentOrders(dsA.manager);
    });
  });
});
