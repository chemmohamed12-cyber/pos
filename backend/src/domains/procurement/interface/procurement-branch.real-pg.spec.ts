import { randomUUID } from 'crypto';
import { PurchaseOrderService } from '../application/purchase-order.service';
import { purchaseOrderBranchOf, warehouseBranchOf } from '../application/procurement-org';
import { OrganizationService } from '../../../foundation/organization/organization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { makeProductLifecycleGate } from './product-lifecycle-gate.test-helper';
import { makeWarehouseLookup } from './warehouse-lookup.test-helper';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Org engine Stage 6 (real PostgreSQL) — procurement documents carry their organizational reference through the EXISTING `purchase_orders.orgUnitId`, derived on
 * the server from the ordering warehouse's owning branch; later documents (receipts, invoices, credit notes, returns) resolve the same branch from the PO or their
 * own warehouse. No branch information -> `null`. Also the HR/department mapping helper: a department resolves to the branch above it.
 */
describe('Procurement + HR organizational mapping (real Postgres)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let orders: PurchaseOrderService;
  let org: OrganizationService;
  const actor = randomUUID();
  const ids = { root: '', x: '', y: '', dept: '', team: '', whX: randomUUID(), whCustody: randomUUID(), whLegacy: randomUUID(), product: randomUUID(), supplier: randomUUID() };

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'proc_branch', extraCompanyTags: ['sales', 'inventory', 'procurement'] });
    const ds = await h.connections.getDataSource(h.companyAId);
    org = new OrganizationService(ds);
    ids.root = (await org.createUnit('company', 'Mother')).id;
    ids.x = (await org.createUnit('branch', 'X', ids.root)).id;
    ids.y = (await org.createUnit('branch', 'Y', ids.root)).id;
    ids.dept = (await org.createUnit('department', 'Buying', ids.x)).id;
    ids.team = (await org.createUnit('team', 'Night', ids.dept)).id;
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'PO Tester','po-branch@test.local')`, [actor]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind","orgUnitId") VALUES ($1,'WH-X','X','active','main',$2)`, [ids.whX, ids.x]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind","parentWarehouseId") VALUES ($1,'WH-X-C','X custody','active','operational',$2)`, [ids.whCustody, ids.whX]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,'WH-OLD','Legacy','active','main')`, [ids.whLegacy]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-PB','P','10.00','active')`, [ids.product]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,'SUP-PB','Supplier')`, [ids.supplier]);
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    orders = new PurchaseOrderService(h.controlPlane, new ProcessEngineService(h.controlPlane), numbering, audit, makeProductLifecycleGate(h.controlPlane), makeWarehouseLookup(h.controlPlane));
  });
  afterAll(async () => h.teardown());

  const line = () => ({ productId: ids.product, quantity: '2', unitCostBase: '4.00' });

  it('a PO takes the branch of its ordering warehouse (a custody sub-location resolves to its parent’s branch); an unassigned warehouse gives NULL', async () => {
    const ds = await h.connections.getDataSource(h.companyAId);
    const po = await orders.create({ supplierId: ids.supplier, warehouseId: ids.whX, lines: [line()] }, actor, ds.manager);
    expect(po.orgUnitId).toBe(ids.x);
    const viaCustody = await orders.create({ supplierId: ids.supplier, warehouseId: ids.whCustody, lines: [line()] }, actor, ds.manager);
    expect(viaCustody.orgUnitId).toBe(ids.x);
    const legacy = await orders.create({ supplierId: ids.supplier, warehouseId: ids.whLegacy, lines: [line()] }, actor, ds.manager);
    expect(legacy.orgUnitId).toBeNull(); // no default branch invented
  });

  it('later procurement documents resolve the same branch: from the PO, or from their own warehouse', async () => {
    const ds = await h.connections.getDataSource(h.companyAId);
    const po = await orders.create({ supplierId: ids.supplier, warehouseId: ids.whX, lines: [line()] }, actor, ds.manager);
    expect(await purchaseOrderBranchOf(ds.manager, po.id)).toBe(ids.x);
    expect(await purchaseOrderBranchOf(ds.manager, null)).toBeNull();
    expect(await purchaseOrderBranchOf(ds.manager, randomUUID())).toBeNull();
    expect(await warehouseBranchOf(ds.manager, ids.whCustody)).toBe(ids.x);
    expect(await warehouseBranchOf(ds.manager, ids.whLegacy)).toBeNull();
  });

  it('a stamped PO keeps its branch when the warehouse is later re-linked (history is not rewritten)', async () => {
    const ds = await h.connections.getDataSource(h.companyAId);
    const po = await orders.create({ supplierId: ids.supplier, warehouseId: ids.whX, lines: [line()] }, actor, ds.manager);
    await ds.query(`UPDATE warehouses SET "orgUnitId" = $1 WHERE id = $2`, [ids.y, ids.whX]);
    expect((await ds.query(`SELECT "orgUnitId" FROM purchase_orders WHERE id = $1`, [po.id]))[0].orgUnitId).toBe(ids.x);
    await ds.query(`UPDATE warehouses SET "orgUnitId" = $1 WHERE id = $2`, [ids.x, ids.whX]);
  });

  it('HR mapping: a department (or team) resolves to the branch above it; a branch to itself; a root or unknown unit to none', async () => {
    expect((await org.getBranchOf(ids.dept))?.id).toBe(ids.x);
    expect((await org.getBranchOf(ids.team))?.id).toBe(ids.x);
    expect((await org.getBranchOf(ids.y))?.id).toBe(ids.y);
    expect(await org.getBranchOf(ids.root)).toBeNull();
    expect(await org.getBranchOf(randomUUID())).toBeNull();
  });
});
