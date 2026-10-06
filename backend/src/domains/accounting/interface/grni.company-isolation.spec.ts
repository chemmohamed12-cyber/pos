import { randomUUID } from 'crypto';
import { GrniReconciliationService } from '../application/grni-reconciliation.service';
import { LedgerService } from '../application/ledger.service';
import { GrniLedgerService } from '../../procurement/application/grni-ledger.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { GrniReconciliationRun } from '../infrastructure/grni-reconciliation-run.entity';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `grni.controller.ts`'s reads/writes are
 * genuinely Company-scoped — two real, separately provisioned Company
 * databases with *different* GRNI positions, never mocked. `reconcile`
 * is the deep-chain proof: it reads the `grni` control account through
 * `LedgerService.getAccountLedger(…, manager)`, the Procurement-owned
 * outstanding-receipt balances through `GrniLedgerContract
 * .getAllGrniBalances(…, manager)`, runs raw-SQL drift arithmetic on the
 * Company manager, and persists the run row there.
 *
 * Company A has an outstanding uninvoiced receipt (4 × 5.00 = 20.00) and
 * an empty GL → `drift_found`; Company B has none → `matched`. A leak in
 * either direction would flip one of those outcomes.
 */
describe('GrniController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: GrniReconciliationService;
  const actorUserId = randomUUID();

  async function seedCompanyData(companyId: string, code: string, outstanding: boolean) {
    const ds = await h.connections.getDataSource(companyId);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Accountant',
      `iso-acct-${companyId}@test.local`,
    ]);
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","controlFunction","allowManualJournal","isActive")
       VALUES ($1,$2,$3,'liability','credit',false,'grni',false,true)`,
      [randomUUID(), `2105-${code}`, `${code} GRNI`],
    );
    if (!outstanding) return;
    const warehouseId = randomUUID();
    const productId = randomUUID();
    const supplierId = randomUUID();
    const purchaseOrderId = randomUUID();
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$3,'active')`, [warehouseId, `WH-${code}`, `${code} Warehouse`]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'10.00','active')`, [productId, `SKU-${code}`, `${code} Product`]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,$2,$3)`, [supplierId, `SUP-${code}`, `${code} Supplier`]);
    await ds.query(`INSERT INTO "purchase_orders" ("id","poNumber","supplierId","warehouseId") VALUES ($1,$2,$3,$4)`, [purchaseOrderId, `PO-${code}`, supplierId, warehouseId]);
    await ds.query(
      `INSERT INTO "purchase_order_lines" ("id","purchaseOrderId","productId","quantity","unitCostBase","lineTotalBase","quantityReceived","quantityInvoiced")
       VALUES ($1,$2,$3,10,'5.00','50.00',4,0)`,
      [randomUUID(), purchaseOrderId, productId],
    );
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'grni_isolation', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    await seedCompanyData(h.companyAId, 'A', true);
    await seedCompanyData(h.companyBId, 'B', false);

    const audit = new AuditService(h.controlPlane);
    service = new GrniReconciliationService(h.controlPlane, new LedgerService(h.controlPlane), audit, new GrniLedgerService(h.controlPlane));
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("reconcile for Company A sees Company A's outstanding receipt (20.00) vs an empty GL -> drift_found, persisted in A's database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const run = await service.reconcile({}, actorUserId, dsA.manager);
    expect(run.status).toBe('drift_found');
    expect(run.subledgerTotalBase).toBe('20.0000');
    expect(await dsA.getRepository(GrniReconciliationRun).findOne({ where: { id: run.id } })).toBeTruthy();
  });

  it("reconcile for Company B sees no outstanding receipts -> matched — Company A's 20.00 never leaks into B", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const run = await service.reconcile({}, actorUserId, dsB.manager);
    expect(run.status).toBe('matched');
    expect(run.subledgerTotalBase).toBe('0.0000');
  });

  it('listRuns via Company A returns only A\'s run, via Company B only B\'s', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const a = await service.listRuns({}, dsA.manager);
    const b = await service.listRuns({}, dsB.manager);
    expect(a.map((r) => r.status)).toEqual(['drift_found']);
    expect(b.map((r) => r.status)).toEqual(['matched']);
  });

  it("getRun / closeRun of Company A's run id through Company B's manager is rejected (A→B DENY)", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const [aRun] = await service.listRuns({}, dsA.manager);
    await expect(service.getRun(aRun.id, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(service.closeRun(aRun.id, actorUserId, dsB.manager)).rejects.toThrow(/not found/i);
  });

  it("closeRun for Company A closes only Company A's run", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const [aRun] = await service.listRuns({}, dsA.manager);
    const closed = await service.closeRun(aRun.id, actorUserId, dsA.manager);
    expect(closed.status).toBe('closed');
    expect((await service.listRuns({}, dsB.manager))[0].status).toBe('matched');
  });

  it("Test F — resolving Company A's GRNI data never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listRuns({}, dsA.manager);
      await service.reconcile({}, actorUserId, dsA.manager);
    });
  });
});
