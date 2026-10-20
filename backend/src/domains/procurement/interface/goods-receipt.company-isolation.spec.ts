import { randomUUID } from 'crypto';
import { GoodsReceiptService } from '../application/goods-receipt.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { GoodsReceipt } from '../infrastructure/goods-receipt.entity';
import { makeProductLifecycleGate } from './product-lifecycle-gate.test-helper';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `goods-receipt.controller.ts`'s reads/writes are
 * genuinely Company-scoped — two real, separately provisioned Company
 * databases, each with its own supplier, warehouse, product and approved
 * Purchase Order, never mocked.
 *
 * `post` is the deep-chain proof: one transaction spanning the PO line
 * increment, the GoodsReceipt rows, the real `InventoryService.recordMovement`
 * ledger write, the outbox publish and the PO Process Engine transition —
 * plus `NumberingService.registerDocumentType('goods_receipt')`, which was
 * un-threaded before this retrofit.
 */
describe('GoodsReceiptController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: GoodsReceiptService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { purchaseOrderId: string; poLineId: string; productId: string; warehouseId: string }> = {
    A: { purchaseOrderId: '', poLineId: '', productId: '', warehouseId: '' },
    B: { purchaseOrderId: '', poLineId: '', productId: '', warehouseId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', code: string) {
    const ds = await h.connections.getDataSource(companyId);
    const warehouseId = randomUUID();
    const productId = randomUUID();
    const supplierId = randomUUID();
    const purchaseOrderId = randomUUID();
    const poLineId = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Buyer',
      `iso-buyer-${companyId}@test.local`,
    ]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$3,'active')`, [warehouseId, `WH-${code}`, `${code} Warehouse`]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'10.00','active')`, [
      productId,
      `SKU-${code}`,
      `${code} Product`,
    ]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,$2,$3)`, [supplierId, `SUP-${code}`, `${code} Supplier`]);
    await ds.query(`INSERT INTO "purchase_orders" ("id","poNumber","supplierId","warehouseId") VALUES ($1,$2,$3,$4)`, [
      purchaseOrderId,
      `PO-GR-${code}`,
      supplierId,
      warehouseId,
    ]);
    await ds.query(
      `INSERT INTO "purchase_order_lines" ("id","purchaseOrderId","productId","quantity","unitCostBase","lineTotalBase") VALUES ($1,$2,$3,10,'5.00','50.00')`,
      [poLineId, purchaseOrderId, productId],
    );
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'purchase_order_lifecycle','purchase_order',$2,'approved')`,
      [randomUUID(), purchaseOrderId],
    );
    seeded[key] = { purchaseOrderId, poLineId, productId, warehouseId };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'gr_isolation', extraCompanyTags: ['sales', 'inventory', 'procurement'] });
    await seedCompanyData(h.companyAId, 'A', 'A');
    await seedCompanyData(h.companyBId, 'B', 'B');

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, inert, undefined);
    service = new GoodsReceiptService(h.controlPlane, processEngine, numbering, audit, inventory, events, makeProductLifecycleGate(h.controlPlane));
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("post for Company A receives against Company A's own PO and writes the stock movement into Company A's ledger only", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const gr = await service.post(
      { purchaseOrderId: seeded.A.purchaseOrderId, lines: [{ purchaseOrderLineId: seeded.A.poLineId, quantityReceived: '4' }] },
      actorUserId,
      dsA.manager,
    );
    expect(gr.purchaseOrderId).toBe(seeded.A.purchaseOrderId);

    const movements: Array<{ quantity: number }> = await dsA.query(`SELECT "quantity" FROM "stock_movements" WHERE "productId" = $1`, [seeded.A.productId]);
    expect(movements.map((m) => Number(m.quantity))).toEqual([4]);
    const state: Array<{ currentState: string }> = await dsA.query(
      `SELECT "currentState" FROM "process_instances" WHERE "entityId" = $1 AND "entityType" = 'purchase_order'`,
      [seeded.A.purchaseOrderId],
    );
    expect(state[0].currentState).toBe('partially_received');
  });

  it("post for Company B receives independently in Company B's own database — Company B's ledger and PO state untouched by A", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const before: Array<{ quantity: number }> = await dsB.query(`SELECT "quantity" FROM "stock_movements"`);
    expect(before).toHaveLength(0);

    const gr = await service.post(
      { purchaseOrderId: seeded.B.purchaseOrderId, lines: [{ purchaseOrderLineId: seeded.B.poLineId, quantityReceived: '10' }] },
      actorUserId,
      dsB.manager,
    );
    expect(gr.purchaseOrderId).toBe(seeded.B.purchaseOrderId);
    const state: Array<{ currentState: string }> = await dsB.query(
      `SELECT "currentState" FROM "process_instances" WHERE "entityId" = $1 AND "entityType" = 'purchase_order'`,
      [seeded.B.purchaseOrderId],
    );
    expect(state[0].currentState).toBe('received');
  });

  it("listForPurchaseOrder resolves only the owning Company's receipts — Company A's PO id is invisible from Company B", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect(await service.listForPurchaseOrder(seeded.A.purchaseOrderId, dsA.manager)).toHaveLength(1);
    expect(await service.listForPurchaseOrder(seeded.A.purchaseOrderId, dsB.manager)).toHaveLength(0);
    expect(await dsB.getRepository(GoodsReceipt).count()).toBe(1);
  });

  it("post of Company A's PO id through Company B's manager is rejected (wrong-resource-id DENY)", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(
      service.post({ purchaseOrderId: seeded.A.purchaseOrderId, lines: [{ purchaseOrderLineId: seeded.A.poLineId, quantityReceived: '1' }] }, actorUserId, dsB.manager),
    ).rejects.toThrow(/not found/i);
  });

  it("Test F — resolving Company A's receipts never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listForPurchaseOrder(seeded.A.purchaseOrderId, dsA.manager);
    });
  });

  it('D7 lifecycle gate — a Goods Receipt on a PO whose product is a DRAFT (unapproved New Item Request) is refused BEFORE any mutation; once active it posts again', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const count = async (t: string) => Number((await dsA.query(`SELECT count(*) AS n FROM "${t}"`))[0].n);
    const [movements, receipts] = [await count('stock_movements'), await count('goods_receipts')];
    await dsA.query(`UPDATE "products" SET "status" = 'draft' WHERE "id" = $1`, [seeded.A.productId]);
    await expect(
      service.post({ purchaseOrderId: seeded.A.purchaseOrderId, lines: [{ purchaseOrderLineId: seeded.A.poLineId, quantityReceived: '1' }] }, actorUserId, dsA.manager),
    ).rejects.toThrow(/draft item/i);
    expect([await count('stock_movements'), await count('goods_receipts')]).toEqual([movements, receipts]); // nothing written
    await dsA.query(`UPDATE "products" SET "status" = 'active' WHERE "id" = $1`, [seeded.A.productId]);
    await service.post({ purchaseOrderId: seeded.A.purchaseOrderId, lines: [{ purchaseOrderLineId: seeded.A.poLineId, quantityReceived: '1' }] }, actorUserId, dsA.manager);
    expect(await count('goods_receipts')).toBe(receipts + 1);
  });
  it('goods received, not invoiced: lists the own-Company orders with their receipts and the uninvoiced value (same columns as the GRNI ledger), narrows by visible warehouse, and drops an order once it is invoiced', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const a = await service.listUninvoiced(dsA.manager);
    expect(a.orders.map((o) => o.purchaseOrderId)).toEqual([seeded.A.purchaseOrderId]);
    expect(a.orders[0].receipts.length).toBe(a.totalReceipts);
    expect(a.totalReceipts).toBeGreaterThan(0);
    const [expected] = await dsA.query(`SELECT COALESCE(SUM((pol."quantityReceived" - pol."quantityInvoiced") * pol."unitCostBase"), 0)::numeric(20,4)::text AS v FROM purchase_order_lines pol WHERE (pol."quantityReceived" - pol."quantityInvoiced") > 0`);
    expect(a.totalValue).toBe(expected.v); // never a second calculation
    const b = await service.listUninvoiced(dsB.manager);
    expect(b.orders.map((o) => o.purchaseOrderId)).toEqual([seeded.B.purchaseOrderId]); // each Company sees only its own
    const [po] = await dsA.query(`SELECT "warehouseId" FROM purchase_orders WHERE id = $1`, [seeded.A.purchaseOrderId]);
    expect((await service.listUninvoiced(dsA.manager, [])).orders).toHaveLength(0); // a caller who sees no warehouse sees nothing
    expect((await service.listUninvoiced(dsA.manager, [po.warehouseId])).orders).toHaveLength(1);
    await dsA.query(`UPDATE purchase_order_lines SET "quantityInvoiced" = "quantityReceived" WHERE "purchaseOrderId" = $1`, [seeded.A.purchaseOrderId]);
    const done = await service.listUninvoiced(dsA.manager);
    expect([done.orders.length, done.totalReceipts, done.totalValue]).toEqual([0, 0, '0.0000']);
  });
});
