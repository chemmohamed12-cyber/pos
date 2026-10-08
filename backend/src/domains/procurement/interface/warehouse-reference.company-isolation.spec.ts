import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { PurchaseRequestService } from '../application/purchase-request.service';
import { PurchaseOrderService } from '../application/purchase-order.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { makeProductLifecycleGate } from './product-lifecycle-gate.test-helper';
import { makeWarehouseLookup } from './warehouse-lookup.test-helper';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Data-integrity defect found during the Authorization Foundation closure (2026-10-08): `purchase_requests.warehouseId` (and
 * `purchase_orders.warehouseId`, `sales_orders.warehouseId`) carry no FK, and the create paths never checked the warehouse — a PR
 * pointing at a nonexistent warehouse was persisted (201). Real-Postgres proof, two separately provisioned Company databases, that:
 *   - an unknown warehouse id is rejected with 404 BEFORE any mutation (no row, no line, no process instance, no number consumed);
 *   - another Company's real warehouse id is "unknown" too — it is resolved only in the caller's own Company database;
 *   - a valid warehouse still creates normally.
 */
describe('Warehouse reference on create paths — real-Postgres (2026-10-08)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let requests: PurchaseRequestService;
  let orders: PurchaseOrderService;
  let salesOrders: SalesOrdersService;
  const actorUserId = randomUUID();
  const unknownWarehouseId = randomUUID();

  const seeded: Record<'A' | 'B', { warehouseId: string; productId: string; supplierId: string }> = {
    A: { warehouseId: '', productId: '', supplierId: '' },
    B: { warehouseId: '', productId: '', supplierId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', code: string) {
    const ds = await h.connections.getDataSource(companyId);
    const warehouseId = randomUUID();
    const productId = randomUUID();
    const supplierId = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [actorUserId, 'Warehouse Ref Tester', `wh-ref-${companyId}@test.local`]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$3,'active')`, [warehouseId, `WH-${code}`, `${code} Warehouse`]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'10.00','active')`, [productId, `SKU-${code}`, `${code} Product`]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,$2,$3)`, [supplierId, `SUP-${code}`, `${code} Supplier`]);
    seeded[key] = { warehouseId, productId, supplierId };
  }

  async function counts(companyId: string): Promise<Record<string, number>> {
    const ds = await h.connections.getDataSource(companyId);
    const one = async (sql: string) => Number((await ds.query(sql))[0].n);
    return {
      purchaseRequests: await one(`SELECT count(*) AS n FROM "purchase_requests"`),
      purchaseRequestLines: await one(`SELECT count(*) AS n FROM "purchase_request_lines"`),
      purchaseOrders: await one(`SELECT count(*) AS n FROM "purchase_orders"`),
      salesOrders: await one(`SELECT count(*) AS n FROM "sales_orders"`),
      processInstances: await one(`SELECT count(*) AS n FROM "process_instances"`),
      numbersIssued: await one(`SELECT COALESCE(sum("lastNumber"),0) AS n FROM "numbering_sequences"`),
    };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'wh_ref', extraCompanyTags: ['sales', 'inventory', 'procurement'] });
    await seedCompanyData(h.companyAId, 'A', 'A');
    await seedCompanyData(h.companyBId, 'B', 'B');

    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const gate = makeProductLifecycleGate(h.controlPlane);
    const warehouses = makeWarehouseLookup(h.controlPlane);
    requests = new PurchaseRequestService(h.controlPlane, processEngine, numbering, audit, gate, warehouses);
    orders = new PurchaseOrderService(h.controlPlane, processEngine, numbering, audit, gate, warehouses);
    // The warehouse check runs before anything else in `createOrder` touches a collaborator, so every other one stays inert.
    const inert = {} as never;
    salesOrders = new SalesOrdersService(inert, inert, inert, inert, inert, inert, inert, inert, inert, inert, warehouses);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it('Purchase Request: an unknown warehouse id is rejected with 404 and nothing is persisted or numbered', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const before = await counts(h.companyAId);
    await expect(requests.create({ warehouseId: unknownWarehouseId, lines: [{ productId: seeded.A.productId, quantity: '1' }] }, actorUserId, dsA.manager)).rejects.toBeInstanceOf(NotFoundException);
    expect(await counts(h.companyAId)).toEqual(before);
  });

  it("Purchase Request: Company B's real warehouse id is unknown to Company A (404), and Company B is untouched", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const beforeA = await counts(h.companyAId);
    const beforeB = await counts(h.companyBId);
    await expect(requests.create({ warehouseId: seeded.B.warehouseId, lines: [{ productId: seeded.A.productId, quantity: '1' }] }, actorUserId, dsA.manager)).rejects.toThrow(/Warehouse .* not found/);
    expect(await counts(h.companyAId)).toEqual(beforeA);
    expect(await counts(h.companyBId)).toEqual(beforeB);
  });

  it("Purchase Request: the Company's own warehouse still creates normally", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const pr = await requests.create({ warehouseId: seeded.A.warehouseId, lines: [{ productId: seeded.A.productId, quantity: '3' }] }, actorUserId, dsA.manager);
    const rows: Array<{ warehouseId: string }> = await dsA.query(`SELECT "warehouseId" FROM "purchase_requests" WHERE id = $1`, [pr.id]);
    expect(rows).toEqual([{ warehouseId: seeded.A.warehouseId }]);
  });

  it("Purchase Order: an unknown (or another Company's) warehouse id is rejected with 404 before any mutation; a valid one creates", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const line = { productId: seeded.A.productId, quantity: '2', unitCostBase: '4.00' };
    const before = await counts(h.companyAId);
    await expect(orders.create({ supplierId: seeded.A.supplierId, warehouseId: unknownWarehouseId, lines: [line] }, actorUserId, dsA.manager)).rejects.toBeInstanceOf(NotFoundException);
    await expect(orders.create({ supplierId: seeded.A.supplierId, warehouseId: seeded.B.warehouseId, lines: [line] }, actorUserId, dsA.manager)).rejects.toBeInstanceOf(NotFoundException);
    expect(await counts(h.companyAId)).toEqual(before);

    const po = await orders.create({ supplierId: seeded.A.supplierId, warehouseId: seeded.A.warehouseId, lines: [line] }, actorUserId, dsA.manager);
    expect(po.warehouseId).toBe(seeded.A.warehouseId);
  });

  it('Sales Order: an unknown warehouse id is rejected with 404 up front (not a late "insufficient stock" 409) and nothing is persisted or numbered', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const before = await counts(h.companyAId);
    await expect(
      salesOrders.createOrder(randomUUID(), actorUserId, [{ productId: seeded.A.productId, quantity: 1 } as never], actorUserId, unknownWarehouseId, 'company_vehicles', false, dsA.manager),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await counts(h.companyAId)).toEqual(before);
  });
});
