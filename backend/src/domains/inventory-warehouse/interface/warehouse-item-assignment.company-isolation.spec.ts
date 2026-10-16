import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { InventoryService } from '../application/inventory.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { ProductsService } from '../../commerce/application/products.service';
import { CreateWarehouseItems1789940000000 } from '../../../database/migrations/inventory/1789940000000-CreateWarehouseItems';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * D1 (2026-10-05) — real Item↔Warehouse assignment, real PostgreSQL, Company A with Company B as the untouched witness.
 * CTO policy (2026-10-05): the assignment is the item's DEFAULT / ORIGIN warehouse — master data (many-to-many, UNIQUE per pair,
 * NO balances) — not a restriction and not evidence of presence. The grid defaults to the assigned items plus any item that
 * still holds stock (never silently hidden); where stock IS comes only from the movements; items move by Transfer.
 */
describe('D1 — Item↔Warehouse assignment (master data, grid scope, backfill) — real-Postgres, A/B', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: InventoryService;
  const actor = randomUUID();
  const ids = { whA: randomUUID(), whA2: randomUUID(), whB: randomUUID(), p1: randomUUID(), p2: randomUUID(), p3: randomUUID(), pB: randomUUID() };

  const dsA = () => h.connections.getDataSource(h.companyAId);
  const dsB = () => h.connections.getDataSource(h.companyBId);
  const pairs = async (ds: Awaited<ReturnType<typeof dsA>>, wh: string) =>
    (await ds.query(`SELECT "productId" FROM warehouse_items WHERE "warehouseId" = $1 ORDER BY "productId"`, [wh])).map((r: { productId: string }) => r.productId);

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'd1_assignment', extraCompanyTags: ['sales', 'inventory'] });
    const inert = {} as never;
    // Master data step 1: `unassignItem` now clears a primary default warehouse through the Sales contract, so the real products service is wired (assertions unchanged).
    const audit = new AuditService(h.controlPlane);
    service = new InventoryService(h.controlPlane, audit, new ProductsService(h.controlPlane, audit, inert), inert, inert, inert, undefined);
    for (const [ds, wh, wh2] of [[await dsA(), ids.whA, ids.whA2], [await dsB(), ids.whB, null]] as const) {
      await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$2,'active')`, [wh, `WH-${wh.slice(0, 4)}`]);
      if (wh2) await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$2,'active')`, [wh2, `WH-${wh2.slice(0, 4)}`]);
    }
    const a = await dsA();
    for (const [id, sku] of [[ids.p1, 'SKU-1'], [ids.p2, 'SKU-2'], [ids.p3, 'SKU-3']] as const) {
      await a.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$2,'10.00','active')`, [id, sku]);
    }
    await (await dsB()).query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-B','SKU-B','10.00','active')`, [ids.pB]);
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('D1 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  it('1. BACKFILL (the migration\'s own SQL on pre-existing data): every pair with a stock movement or an active reservation is assigned; nothing else', async () => {
    const a = await dsA();
    await a.query(`DROP TABLE "warehouse_items"`);
    await a.query(`INSERT INTO "stock_movements" ("id","warehouseId","productId","quantity","movementType") VALUES ($1,$2,$3,5,'receipt')`, [randomUUID(), ids.whA, ids.p2]);
    await a.query(`INSERT INTO "stock_reservations" ("id","warehouseId","productId","quantity","salesOrderId","status") VALUES ($1,$2,$3,1,$4,'active')`, [randomUUID(), ids.whA2, ids.p3, randomUUID()]);
    await a.query(`INSERT INTO "stock_reservations" ("id","warehouseId","productId","quantity","salesOrderId","status") VALUES ($1,$2,$3,1,$4,'fulfilled')`, [randomUUID(), ids.whA2, ids.p1, randomUUID()]);
    const qr = a.createQueryRunner();
    await new CreateWarehouseItems1789940000000().up(qr);
    await qr.release();
    expect(await pairs(a, ids.whA)).toEqual([ids.p2]); // movement → assigned
    expect(await pairs(a, ids.whA2)).toEqual([ids.p3]); // active reservation → assigned; the 'fulfilled' one is not
  });

  it('2. MASTER DATA ONLY: warehouse_items has no quantity/value column; UNIQUE per pair', async () => {
    const a = await dsA();
    const cols: Array<{ column_name: string }> = await a.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'warehouse_items' ORDER BY column_name`);
    expect(cols.map((c) => c.column_name)).toEqual(['assignedByUserId', 'createdAt', 'id', 'productId', 'warehouseId']);
    await expect(a.query(`INSERT INTO warehouse_items ("warehouseId","productId") VALUES ($1,$2)`, [ids.whA, ids.p2])).rejects.toThrow(/UQ_warehouse_items_pair|duplicate/i);
  });

  it('3. ASSIGN is bulk + idempotent; an unknown item or warehouse is rejected with ZERO writes', async () => {
    const a = await dsA();
    const before = await pairs(a, ids.whA);
    await expect(service.assignItems(ids.whA, [ids.p1, randomUUID()], actor, a.manager)).rejects.toBeInstanceOf(NotFoundException);
    expect(await pairs(a, ids.whA)).toEqual(before);
    await expect(service.assignItems(randomUUID(), [ids.p1], actor, a.manager)).rejects.toBeInstanceOf(NotFoundException);

    const first = await service.assignItems(ids.whA, [ids.p1, ids.p2], actor, a.manager); // p2 already assigned by the backfill
    expect(first).toEqual({ requested: 2, assigned: 1, alreadyAssigned: 1 });
    expect(await service.assignItems(ids.whA, [ids.p1, ids.p2], actor, a.manager)).toEqual({ requested: 2, assigned: 0, alreadyAssigned: 2 });
    // many-to-many: the same item in a second warehouse
    await service.assignItems(ids.whA2, [ids.p1], actor, a.manager);
    expect((await pairs(a, ids.whA2)).sort()).toEqual([ids.p1, ids.p3].sort());
  });

  it('4. GRID default scope = assigned items + any item still holding stock; "all" = the whole catalogue; every row reports `assigned`', async () => {
    const a = await dsA();
    // p3 is NOT assigned to whA and has no stock there; p2 gets stock via an UNASSIGNED path (remove its assignment first is blocked, so use whA2: p3 is assigned there)
    const assigned = await service.getWarehouseInventoryPage(ids.whA, { page: 1, pageSize: 50, scope: 'assigned' }, a.manager);
    expect(assigned.rows.map((r) => [r.sku, r.assigned, r.onHand]).sort()).toEqual([['SKU-1', true, 0], ['SKU-2', true, 5]]);
    expect(assigned.total).toBe(2);

    const all = await service.getWarehouseInventoryPage(ids.whA, { page: 1, pageSize: 50, scope: 'all' }, a.manager);
    expect(all.rows.map((r) => [r.sku, r.assigned]).sort()).toEqual([['SKU-1', true], ['SKU-2', true], ['SKU-3', false]]);

    // stock is never silently hidden: put stock on an UNASSIGNED item through the ledger → it still appears in the assigned scope, flagged false
    await service.recordMovement(ids.whA, ids.p3, 7, 'receipt', 'test_receipt', null, actor, a.manager);
    const withStray = await service.getWarehouseInventoryPage(ids.whA, { page: 1, pageSize: 50, scope: 'assigned' }, a.manager);
    expect(withStray.rows.map((r) => [r.sku, r.assigned, r.onHand]).sort()).toEqual([['SKU-1', true, 0], ['SKU-2', true, 5], ['SKU-3', false, 7]]);
  });

  it('5. DEFAULT/ORIGIN, not a restriction: removing the marker is always allowed (it is metadata) — the stock stays the ledger sum and the item stays visible as "holds stock, not a default"', async () => {
    const a = await dsA();
    expect(await service.getOnHand(ids.whA, ids.p2, a.manager)).toBe(5);
    expect(await service.unassignItem(ids.whA, ids.p2, actor, a.manager)).toEqual({ removed: true }); // 5 on hand — NOT blocked
    expect(await pairs(a, ids.whA)).not.toContain(ids.p2);
    expect(await service.unassignItem(ids.whA, ids.p2, actor, a.manager)).toEqual({ removed: false }); // idempotent
    expect(await service.getOnHand(ids.whA, ids.p2, a.manager)).toBe(5); // unchanged — assignment never touches stock
    const grid = await service.getWarehouseInventoryPage(ids.whA, { page: 1, pageSize: 50, scope: 'assigned' }, a.manager);
    expect(grid.rows.find((r) => r.sku === 'SKU-2')).toMatchObject({ assigned: false, onHand: 5 }); // still visible: movements are the truth

    // an item transferred away is not "in" its origin warehouse any more: stock is per warehouse from the movements
    await service.recordMovement(ids.whA, ids.p2, -5, 'transfer_out', 'test_transfer', null, actor, a.manager);
    await service.recordMovement(ids.whA2, ids.p2, 5, 'transfer_in', 'test_transfer', null, actor, a.manager);
    expect(await service.getOnHand(ids.whA, ids.p2, a.manager)).toBe(0);
    expect(await service.getOnHand(ids.whA2, ids.p2, a.manager)).toBe(5);
  });

  it('6. NOTHING is blocked by assignment (advisory stage): a movement for an UNASSIGNED pair still posts and stock stays the ledger sum', async () => {
    const a = await dsA();
    expect(await pairs(a, ids.whA)).not.toContain(ids.p3);
    await service.recordMovement(ids.whA, ids.p3, 3, 'receipt', 'test_receipt', null, actor, a.manager);
    expect(await service.getOnHand(ids.whA, ids.p3, a.manager)).toBe(10); // 7 + 3
  });

  it('7. ISOLATION: Company B has its own (empty) assignments; A\'s ids are unknown to B; the Platform/other-Company DataSource is never requested', async () => {
    const a = await dsA();
    const b = await dsB();
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.assignItems(ids.whA, [ids.p1], actor, a.manager);
      await service.getWarehouseInventoryPage(ids.whA, { page: 1, pageSize: 10 }, a.manager);
    });
    expect(Number((await b.query(`SELECT count(*) AS n FROM warehouse_items`))[0].n)).toBe(0);
    await expect(service.assignItems(ids.whA, [ids.p1], actor, b.manager)).rejects.toBeInstanceOf(NotFoundException); // A's warehouse is unknown to B
    await expect(service.assignItems(ids.whB, [ids.p1], actor, b.manager)).rejects.toBeInstanceOf(NotFoundException); // A's product is unknown to B
    expect(await service.assignItems(ids.whB, [ids.pB], actor, b.manager)).toEqual({ requested: 1, assigned: 1, alreadyAssigned: 0 });
    expect(await pairs(a, ids.whA)).not.toContain(ids.pB);
  });

  it('8. LIST (Products screen column): every marker of the Company; the F6 visible-warehouse filter keeps only those warehouses; per Company', async () => {
    const a = await dsA();
    const b = await dsB();
    const key = (r: { warehouseId: string; productId: string }) => `${r.warehouseId}:${r.productId}`;
    const expected: Array<{ warehouseId: string; productId: string }> = await a.query(`SELECT "warehouseId", "productId" FROM warehouse_items`);
    expect((await service.listWarehouseItemAssignments(undefined, a.manager)).map(key).sort()).toEqual(expected.map(key).sort());
    const onlyA2 = await service.listWarehouseItemAssignments([ids.whA2], a.manager);
    expect(onlyA2.length).toBeGreaterThan(0);
    expect(onlyA2.every((r) => r.warehouseId === ids.whA2)).toBe(true);
    expect(await service.listWarehouseItemAssignments([], a.manager)).toEqual([]);
    expect((await service.listWarehouseItemAssignments(undefined, b.manager)).map(key)).toEqual([`${ids.whB}:${ids.pB}`]);
  });
});
