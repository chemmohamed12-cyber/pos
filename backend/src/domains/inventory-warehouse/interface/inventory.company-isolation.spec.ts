import { EventBusService } from '../../../foundation/events/event-bus.service';
import { randomUUID } from 'crypto';
import { InventoryService } from '../application/inventory.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * Real-Postgres proof that `inventory.controller.ts`'s reads/writes are
 * genuinely Company-scoped after this retrofit — two real, separately
 * provisioned Company databases, each with its own distinct warehouse,
 * product, stock movement, and reservation, never mocked.
 *
 * `InventoryService` is constructed with only its actually-invoked
 * dependencies real (`AuditService` is invoked by `recordMovement`/
 * `reserveStockInTransaction`, so a real one bound to the harness's own
 * control-plane DataSource is used — it only ever writes an outbox-style
 * row, never reads back what it wrote); `SalesProductsContract`/
 * `SalesBomContract`/`NumberingService`/`EventBusService`/valuation are
 * never invoked by the methods this test exercises and are passed as
 * inert stand-ins, same "construct only what the code path under test
 * actually needs" precedent as every other Area 21 isolation spec.
 */
describe('InventoryController Area 21 retrofit — real-Postgres Company isolation (2026-09-27)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: InventoryService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { warehouseId: string; productId: string; salesOrderId: string }> = {
    A: { warehouseId: '', productId: '', salesOrderId: '' },
    B: { warehouseId: '', productId: '', salesOrderId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', warehouseCode: string, sku: string) {
    const ds = await h.connections.getDataSource(companyId);
    const warehouseId = randomUUID();
    const productId = randomUUID();
    const salesOrderId = randomUUID();

    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$3,'active')`, [
      warehouseId,
      warehouseCode,
      `${warehouseCode} Warehouse`,
    ]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'10.00','active')`, [
      productId,
      sku,
      `${sku} Product`,
    ]);
    // A receipt movement (on-hand = 100), then a reservation of 30 against it (available = 70).
    await ds.query(
      `INSERT INTO "stock_movements" ("id","warehouseId","productId","quantity","movementType") VALUES ($1,$2,$3,100,'receipt')`,
      [randomUUID(), warehouseId, productId],
    );
    await ds.query(
      `INSERT INTO "stock_reservations" ("id","warehouseId","productId","quantity","salesOrderId","status") VALUES ($1,$2,$3,30,$4,'active')`,
      [randomUUID(), warehouseId, productId, salesOrderId],
    );

    seeded[key] = { warehouseId, productId, salesOrderId };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'inventory_isolation', extraCompanyTags: ['sales', 'inventory'] });
    await seedCompanyData(h.companyAId, 'A', 'WH-A-001', 'SKU-INV-A');
    await seedCompanyData(h.companyBId, 'B', 'WH-B-001', 'SKU-INV-B');

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    service = new InventoryService(h.controlPlane, audit, inert, inert, inert, new EventBusService(inert, h.connections), undefined);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("listWarehouses via Company A resolves only Company A's real warehouse", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const warehouses = await service.listWarehouses(dsA.manager);
    expect(warehouses.map((w) => w.code)).toEqual(['WH-A-001']);
  });

  it("listWarehouses via Company B resolves only Company B's real warehouse — no leakage of Company A's data", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const warehouses = await service.listWarehouses(dsB.manager);
    expect(warehouses.map((w) => w.code)).toEqual(['WH-B-001']);
  });

  it("getAvailable for Company A's own warehouse/product resolves the correct on-hand/reserved figures — never Company B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const available = await service.getAvailable(seeded.A.warehouseId, seeded.A.productId, dsA.manager);
    expect(available).toBe(70); // 100 on-hand - 30 reserved
  });

  it("getAvailable for Company A's warehouse/product via Company B's manager sees nothing (the rows genuinely do not exist in Company B's own database)", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const available = await service.getAvailable(seeded.A.warehouseId, seeded.A.productId, dsB.manager);
    expect(available).toBe(0);
  });

  it("getActiveReservationsForOrder via Company A resolves only Company A's real reservation", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const reservations = await service.getActiveReservationsForOrder(seeded.A.salesOrderId, dsA.manager);
    expect(reservations).toHaveLength(1);
    expect(reservations[0].productId).toBe(seeded.A.productId);
  });

  it("recordMovement writes into the correct Company's own ledger — verified via that Company's own getOnHand afterwards", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    await service.recordMovement(seeded.A.warehouseId, seeded.A.productId, 15, 'adjustment', null, null, actorUserId, dsA.manager);
    expect(await service.getOnHand(seeded.A.warehouseId, seeded.A.productId, dsA.manager)).toBe(115);
    // Company B's own on-hand for its own (different) warehouse/product is untouched.
    expect(await service.getOnHand(seeded.B.warehouseId, seeded.B.productId, dsB.manager)).toBe(100);
  });

  it("Test F — resolving Company A's inventory never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listWarehouses(dsA.manager);
      await service.getAvailable(seeded.A.warehouseId, seeded.A.productId, dsA.manager);
      await service.getActiveReservationsForOrder(seeded.A.salesOrderId, dsA.manager);
    });
  });
});
