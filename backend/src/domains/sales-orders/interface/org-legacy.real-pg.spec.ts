import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { OrgLegacyService } from '../../../foundation/organization/org-legacy.service';
import { PurchaseOrderService } from '../../procurement/application/purchase-order.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { makeProductLifecycleGate } from '../../procurement/interface/product-lifecycle-gate.test-helper';
import { makeWarehouseLookup } from '../../procurement/interface/warehouse-lookup.test-helper';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Org engine Stage 8 (real PostgreSQL) — legacy reconciliation: only DERIVABLE references are assigned (from the warehouse's owning branch / the parent document),
 * the rest stay NULL and are reported; a dry run writes nothing; the confirmed run is logged row by row, is idempotent (re-run = nothing left), never overwrites an
 * existing reference, never changes an amount (checksums), and never touches the other Company.
 */
describe('Legacy organizational reconciliation (real Postgres)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ds: DataSource;
  let dsB: DataSource;
  let legacy: OrgLegacyService;
  let pos: PurchaseOrderService;
  const actor = randomUUID();
  const ids = { root: randomUUID(), x: randomUUID(), y: randomUUID(), whX: randomUUID(), whNone: randomUUID(), whY: randomUUID(), customer: randomUUID(), product: randomUUID(), supplier: randomUUID() };
  const soNull = { withBranchWh: randomUUID(), noWh: randomUUID(), noBranchWh: randomUUID(), alreadyY: randomUUID() };

  const order = (id: string, wh: string | null, branch: string | null, total: string) =>
    ds.query(
      `INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount","repSequenceNumber","createdByUserId","warehouseId","branchOrgUnitId") VALUES ($1,$2,$3,$4,$5,1,$4,$6,$7)`,
      [id, `SO-${id.slice(0, 8)}`, ids.customer, actor, total, wh, branch],
    );

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'org_legacy', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'logistics'] });
    ds = await h.connections.getDataSource(h.companyAId);
    dsB = await h.connections.getDataSource(h.companyBId);
    legacy = new OrgLegacyService(h.controlPlane);
    pos = new PurchaseOrderService(h.controlPlane, new ProcessEngineService(h.controlPlane), new NumberingService(h.controlPlane), new AuditService(h.controlPlane), makeProductLifecycleGate(h.controlPlane), makeWarehouseLookup(h.controlPlane));
    await ds.query(`INSERT INTO org_units (id,type,name,"parentId") VALUES ($1,'company','Mother',NULL),($2,'branch','X',$1),($3,'branch','Y',$1)`, [ids.root, ids.x, ids.y]);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Leg','leg@test.local')`, [actor]);
    await ds.query(`INSERT INTO "customers" ("id","code","name","creditLimit","paymentTermsDays") VALUES ($1,'CUST-LG','C','1000',30)`, [ids.customer]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-LG','P','10.00','active')`, [ids.product]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,'SUP-LG','S')`, [ids.supplier]);
    // legacy warehouses: whX is NOW linked to branch X; whNone is not linked to anything
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind","orgUnitId") VALUES ($1,'WH-X','X','active','main',$2),($3,'WH-N','N','active','main',NULL),($4,'WH-Y','Y','active','main',$5)`, [ids.whX, ids.x, ids.whNone, ids.whY, ids.y]);
    await order(soNull.withBranchWh, ids.whX, null, '100.00');
    await order(soNull.noWh, null, null, '40.00');
    await order(soNull.noBranchWh, ids.whNone, null, '60.00');
    await order(soNull.alreadyY, ids.whX, ids.y, '25.00'); // history already says Y although the warehouse is now X: must NOT be rewritten
    // child documents of the first order
    await ds.query(`INSERT INTO sales_invoices (id,"invoiceNumber","customerId","salesOrderId",subtotal,"discountAmount","taxAmount","totalAmount","createdByUserId") VALUES ($1,'INV-LG-1',$2,$3,'100.00','0.00','0.00','100.00',$4)`, [randomUUID(), ids.customer, soNull.withBranchWh, actor]);
    await ds.query(`INSERT INTO shipments (id,"fulfillmentOrderId","waybillNumber","salesOrderId") VALUES ($1,$2,'WB-LG-1',$3)`, [randomUUID(), randomUUID(), soNull.withBranchWh]);
    // legacy purchase orders: created while the warehouse had no branch
    await ds.query(`UPDATE warehouses SET "orgUnitId" = NULL WHERE id = $1`, [ids.whX]);
    await pos.create({ supplierId: ids.supplier, warehouseId: ids.whX, lines: [{ productId: ids.product, quantity: '2', unitCostBase: '4.00' }] }, actor, ds.manager);
    await pos.create({ supplierId: ids.supplier, warehouseId: ids.whNone, lines: [{ productId: ids.product, quantity: '1', unitCostBase: '9.00' }] }, actor, ds.manager);
    await ds.query(`UPDATE warehouses SET "orgUnitId" = $1 WHERE id = $2`, [ids.x, ids.whX]); // the owner later assigned the warehouse to branch X
  });
  afterAll(async () => h.teardown());

  it('inventory: counts what is unassigned, what a relationship can name, and what cannot be named (stays NULL)', async () => {
    const inv = await legacy.inventory(ds.manager);
    const so = inv.documents.find((d) => d.table === 'sales_orders')!;
    expect(so).toMatchObject({ installed: true, total: 4, stamped: 1, unassigned: 3, derivable: 1, notDerivable: 2 });
    expect(inv.documents.find((d) => d.table === 'purchase_orders')).toMatchObject({ total: 2, unassigned: 2, derivable: 1, notDerivable: 1 });
    expect(inv.issues).toEqual([]);
  });

  it('a dry run reports exactly what would change and writes nothing (no log, no stamp)', async () => {
    const before = JSON.stringify(await ds.query(`SELECT id,"branchOrgUnitId" FROM sales_orders ORDER BY id`));
    const dry = await legacy.backfill({ dryRun: true, actorUserId: actor }, ds.manager);
    expect(dry.dryRun).toBe(true);
    expect(dry.runId).toBeNull();
    expect(dry.steps.find((s) => s.table === 'sales_orders')!.assigned).toBe(1);
    expect(JSON.stringify(await ds.query(`SELECT id,"branchOrgUnitId" FROM sales_orders ORDER BY id`))).toBe(before);
    expect(Number((await ds.query(`SELECT count(*)::int n FROM org_migration_log`))[0].n)).toBe(0);
  });

  it('the confirmed run assigns only derivable rows, keeps existing history, logs every write and proves the amounts did not move', async () => {
    const run = await legacy.backfill({ actorUserId: actor }, ds.manager);
    const q = async (sql: string, p: unknown[] = []) => ds.query(sql, p);
    expect((await q(`SELECT "branchOrgUnitId" b FROM sales_orders WHERE id = $1`, [soNull.withBranchWh]))[0].b).toBe(ids.x); // derived from the warehouse
    expect((await q(`SELECT "branchOrgUnitId" b FROM sales_orders WHERE id = $1`, [soNull.noWh]))[0].b).toBeNull(); // nothing to derive from: stays NULL
    expect((await q(`SELECT "branchOrgUnitId" b FROM sales_orders WHERE id = $1`, [soNull.noBranchWh]))[0].b).toBeNull(); // warehouse without a branch: stays NULL
    expect((await q(`SELECT "branchOrgUnitId" b FROM sales_orders WHERE id = $1`, [soNull.alreadyY]))[0].b).toBe(ids.y); // history is never rewritten
    expect((await q(`SELECT "branchOrgUnitId" b FROM sales_invoices LIMIT 1`))[0].b).toBe(ids.x); // child follows its (just backfilled) parent
    expect((await q(`SELECT "branchOrgUnitId" b FROM shipments LIMIT 1`))[0].b).toBe(ids.x);
    expect((await q(`SELECT "orgUnitId" u FROM purchase_orders WHERE "warehouseId" = $1`, [ids.whX]))[0].u).toBe(ids.x);
    expect((await q(`SELECT "orgUnitId" u FROM purchase_orders WHERE "warehouseId" = $1`, [ids.whNone]))[0].u).toBeNull();
    const log = await legacy.log(run.runId!, ds.manager);
    expect(log.length).toBe(run.steps.reduce((n, s) => n + s.assigned, 0));
    expect(log.every((l: { fromValue: string | null; source: string }) => l.fromValue === null && l.source.length > 0)).toBe(true);
    for (const s of run.steps) expect(s.checksumBefore).toEqual(s.checksumAfter);
    expect(Number(run.steps.find((s) => s.table === 'sales_orders')!.checksumAfter.totalAmount)).toBe(225); // 100 + 40 + 60 + 25 — the amounts are exactly what they were
  });

  it('re-running is a no-op (nothing left to derive), and the inventory now shows the remainder as not derivable', async () => {
    const again = await legacy.backfill({ actorUserId: actor }, ds.manager);
    expect(again.steps.filter((s) => s.installed).every((s) => s.assigned === 0)).toBe(true);
    const so = (await legacy.inventory(ds.manager)).documents.find((d) => d.table === 'sales_orders')!;
    expect(so).toMatchObject({ unassigned: 2, derivable: 0, notDerivable: 2 });
  });

  it('refuses an unknown table, and Company B is untouched', async () => {
    await expect(legacy.backfill({ tables: ['users'] }, ds.manager)).rejects.toThrow(/Unknown table/);
    expect((await legacy.inventory(dsB.manager)).documents.find((d) => d.table === 'sales_orders')).toMatchObject({ total: 0 });
    expect(Number((await dsB.query(`SELECT count(*)::int n FROM org_migration_log`))[0].n)).toBe(0);
  });
});
