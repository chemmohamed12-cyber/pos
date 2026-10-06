import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { WipReconciliationService } from '../application/wip-reconciliation.service';
import { LedgerService } from '../application/ledger.service';
import { ManufacturingWipLedgerService } from '../../manufacturing/application/manufacturing-wip-ledger.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';
import { WipReconciliationRun } from '../infrastructure/wip-reconciliation-run.entity';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `wip.controller.ts`'s reads/writes are
 * genuinely Company-scoped — two real, separately provisioned Company
 * databases, each with its own Work Order / WIP warehouse and a
 * *different* WIP value (40.00 vs 70.00), so a leak in either direction
 * is immediately visible in `subledgerTotalBase`.
 *
 * `reconcile` is the deep-chain proof: `LedgerService.getAccountLedger`
 * (made manager-capable in §43), the Manufacturing-owned
 * `ManufacturingWipLedgerService.getAllWipBalances` (real, Area 9), and
 * the raw-SQL drift arithmetic all run on the Company manager. The
 * inventory-valuation dependency is a stub that *reads through the
 * manager it is handed* — it would throw if handed `undefined` (the
 * control-plane has no `work_orders` table) — because the cost engine's
 * own Company-isolation is proven by §22.
 */
describe('WipController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: WipReconciliationService;
  const actorUserId = randomUUID();

  async function seedCompanyData(companyId: string, code: string) {
    const ds = await h.connections.getDataSource(companyId);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Accountant',
      `iso-acct-${companyId}@test.local`,
    ]);
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","controlFunction","allowManualJournal","isActive")
       VALUES ($1,$2,$3,'asset','debit',false,'wip',false,true)`,
      [randomUUID(), `1160-${code}`, `${code} WIP`],
    );
    await ds.query(
      `INSERT INTO "work_orders" ("id","workOrderNumber","finishedProductId","quantityPlanned","warehouseId","wipWarehouseId") VALUES ($1,$2,$3,5,$4,$5)`,
      [randomUUID(), `WO-WIP-${code}`, randomUUID(), randomUUID(), randomUUID()],
    );
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'wip_isolation', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting', 'manufacturing'] });
    await seedCompanyData(h.companyAId, 'A');
    await seedCompanyData(h.companyBId, 'B');

    // Reads through the manager it is given: per-Company value keyed off that Company's own work order.
    const valuation = {
      getValuedOnHandTotal: async (_asOf: string | undefined, manager?: EntityManager) => {
        const rows: Array<{ workOrderNumber: string; wipWarehouseId: string }> = await manager!.query(
          `SELECT "workOrderNumber","wipWarehouseId" FROM "work_orders" WHERE "wipWarehouseId" IS NOT NULL`,
        );
        return rows.map((r) => ({ warehouseId: r.wipWarehouseId, totalValueBase: r.workOrderNumber.endsWith('-A') ? '40.0000' : '70.0000' }));
      },
    } as unknown as InventoryValuationContract;

    const audit = new AuditService(h.controlPlane);
    service = new WipReconciliationService(h.controlPlane, new LedgerService(h.controlPlane), audit, new ManufacturingWipLedgerService(h.controlPlane, valuation));
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("reconcile for Company A sees only Company A's WIP (40.00) vs an empty GL -> drift_found, persisted in A's database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const run = await service.reconcile({}, actorUserId, dsA.manager);
    expect(run.status).toBe('drift_found');
    expect(run.subledgerTotalBase).toBe('40.0000');
    expect(await dsA.getRepository(WipReconciliationRun).findOne({ where: { id: run.id } })).toBeTruthy();
  });

  it("reconcile for Company B sees only Company B's WIP (70.00) — never Company A's 40.00, never the sum", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const run = await service.reconcile({}, actorUserId, dsB.manager);
    expect(run.subledgerTotalBase).toBe('70.0000');
  });

  it("listRuns via Company A returns only A's run, via Company B only B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await service.listRuns({}, dsA.manager)).map((r) => r.subledgerTotalBase)).toEqual(['40.0000']);
    expect((await service.listRuns({}, dsB.manager)).map((r) => r.subledgerTotalBase)).toEqual(['70.0000']);
  });

  it("getRun / closeRun of Company A's run id through Company B's manager is rejected (A→B DENY)", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const [aRun] = await service.listRuns({}, dsA.manager);
    await expect(service.getRun(aRun.id, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(service.closeRun(aRun.id, actorUserId, dsB.manager)).rejects.toThrow(/not found/i);
  });

  it("closeRun for Company A closes only Company A's run — B's stays open", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const [aRun] = await service.listRuns({}, dsA.manager);
    expect((await service.closeRun(aRun.id, actorUserId, dsA.manager)).status).toBe('closed');
    expect((await service.listRuns({}, dsB.manager))[0].status).not.toBe('closed');
  });

  it("Test F — resolving Company A's WIP data never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listRuns({}, dsA.manager);
      await service.reconcile({}, actorUserId, dsA.manager);
    });
  });
});
