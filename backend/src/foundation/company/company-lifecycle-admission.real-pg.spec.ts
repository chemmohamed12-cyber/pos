import { DataSource } from 'typeorm';
import { CompanyActivationService } from './company-activation.service';
import { CompanyRegistryService } from './company-registry.service';
import { runOperationalAdmitted } from './company-lifecycle-admission';
// Test-only: this spec proves the lifecycle-admission boundary on the REAL scheduler class of another domain; there is no published contract for it (same documented pattern as integrations.service.ts).
// eslint-disable-next-line no-restricted-imports
import { PreliminaryHoldExpiryScheduler } from '../../domains/sales-orders/application/preliminary-hold-expiry.scheduler';
import { ApprovalExpiryScheduler } from '../approval-engine/approval-expiry.scheduler';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';

/**
 * LA-1 — Lifecycle Admission Boundary, Layer 2: REAL-POSTGRES + two-Company ISOLATION proof
 * (CTO Executive Order 2026-10-06). Real: Platform DB `companies` row locks, CompanyActivationService
 * (the real `suspend`/`decommission` UPDATE), CompanyConnectionManagerService, two real Company
 * databases, the real PreliminaryHoldExpiryScheduler and ApprovalExpiryScheduler classes. Doubles:
 * only the business collaborators those schedulers call (inventory / sales-orders / approval engine).
 */
describe('LA-1 — Layer 2 lifecycle admission (non-HTTP operational paths), real-Postgres + A/B isolation', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let activation: CompanyActivationService;
  let getDataSourceSpy: jest.SpyInstance;

  const platform = () => h.controlPlane as DataSource;
  const dbOf = async (ds: DataSource) => (await ds.query(`SELECT current_database() AS db`))[0].db as string;
  const setStatus = (id: string, status: string) => h.controlPlane.query(`UPDATE "companies" SET "status" = $1 WHERE "id" = $2`, [status, id]);
  const statusOf = async (id: string) => (await h.controlPlane.query(`SELECT "status" FROM "companies" WHERE "id" = $1`, [id]))[0].status as string;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'la1_layer2', roleModuleCodes: ['sales'] });
    activation = new CompanyActivationService(new CompanyRegistryService(h.companies));
    getDataSourceSpy = jest.spyOn(h.connections, 'getDataSource');
  });

  afterAll(async () => {
    await h.teardown();
  });

  beforeEach(async () => {
    await setStatus(h.companyAId, 'READY');
    await setStatus(h.companyBId, 'READY');
    getDataSourceSpy.mockClear();
  });

  it('READY → admitted: the work runs against that Company\'s own database only', async () => {
    const result = await runOperationalAdmitted(platform(), h.connections, h.companyAId, (ds) => dbOf(ds));
    expect(result).toEqual({ admitted: true, value: h.companyADbName });
    expect(getDataSourceSpy).toHaveBeenCalledTimes(1);
    expect(getDataSourceSpy).toHaveBeenCalledWith(h.companyAId);
  });

  it.each(['SUSPENDED', 'DECOMMISSIONED', 'PROVISIONING', 'DEGRADED', 'MIGRATING', 'FAILED'])('%s → refused: the work does not run and the Company DataSource is NEVER requested', async (status) => {
    await setStatus(h.companyAId, status);
    const work = jest.fn(async () => 'ran');
    const result = await runOperationalAdmitted(platform(), h.connections, h.companyAId, work);
    expect(result).toMatchObject({ admitted: false, reason: 'COMPANY_NOT_READY', status });
    expect(work).not.toHaveBeenCalled();
    expect(getDataSourceSpy).not.toHaveBeenCalled();
  });

  it('an unknown Company id is refused (MISSING) and opens nothing', async () => {
    const work = jest.fn(async () => 'ran');
    const result = await runOperationalAdmitted(platform(), h.connections, '00000000-0000-4000-8000-000000000000', work);
    expect(result).toMatchObject({ admitted: false, status: 'MISSING' });
    expect(work).not.toHaveBeenCalled();
    expect(getDataSourceSpy).not.toHaveBeenCalled();
  });

  it('ISOLATION — while A is SUSPENDED, B is admitted and reaches only B\'s database; A is never opened', async () => {
    await activation.suspend(h.companyAId);
    const a = await runOperationalAdmitted(platform(), h.connections, h.companyAId, (ds) => dbOf(ds));
    const b = await runOperationalAdmitted(platform(), h.connections, h.companyBId, (ds) => dbOf(ds));
    expect(a.admitted).toBe(false);
    expect(b).toEqual({ admitted: true, value: h.companyBDbName });
    expect(getDataSourceSpy).toHaveBeenCalledTimes(1);
    expect(getDataSourceSpy).toHaveBeenCalledWith(h.companyBId);
    expect(getDataSourceSpy).not.toHaveBeenCalledWith(h.companyAId);
  });

  it('RACE (V-08) — a suspend() issued while admitted work is in flight WAITS for it; the change only commits after the work ends; any admission after it is refused', async () => {
    const timeline: string[] = [];
    let release!: () => void;
    const latch = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const workStarted = new Promise<void>((r) => (started = r));

    const inFlight = runOperationalAdmitted(platform(), h.connections, h.companyAId, async () => {
      timeline.push('work-start');
      started();
      await latch;
      timeline.push('work-end');
    });
    await workStarted;

    const suspending = activation.suspend(h.companyAId).then(() => timeline.push('suspend-committed'));
    await sleep(750);
    expect(timeline).toEqual(['work-start']); // suspend is blocked behind the in-flight admitted work
    expect(await statusOf(h.companyAId)).toBe('READY'); // the flip is not visible yet

    // An admission that arrives while the suspend is still pending may legitimately start (the flip has not
    // committed) — but then the suspend waits for it too. What must never happen is work AFTER the flip.
    const lateStart = runOperationalAdmitted(platform(), h.connections, h.companyAId, async () => {
      timeline.push('late-work');
    });

    release();
    await inFlight;
    await suspending;
    await lateStart;

    expect(timeline[timeline.length - 1]).toBe('suspend-committed'); // every admitted piece of work finished BEFORE the flip became visible
    expect(timeline.indexOf('work-end')).toBeLessThan(timeline.indexOf('suspend-committed'));
    expect(await statusOf(h.companyAId)).toBe('SUSPENDED');
    const after = await runOperationalAdmitted(platform(), h.connections, h.companyAId, async () => 'x');
    expect(after.admitted).toBe(false);
  });

  it('work that throws releases the lock: the error propagates, a following suspend() is not blocked, and nothing else is affected', async () => {
    await expect(
      runOperationalAdmitted(platform(), h.connections, h.companyAId, async () => {
        throw new Error('job exploded');
      }),
    ).rejects.toThrow('job exploded');
    const t0 = Date.now();
    await activation.suspend(h.companyAId);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await statusOf(h.companyAId)).toBe('SUSPENDED');
  });

  it('SCHEDULED WORK (V-05) — PreliminaryHoldExpiryScheduler: A was READY when the sweep list was built but is SUSPENDED when its turn comes → A is skipped, B still runs against B only', async () => {
    const touched: string[] = [];
    const inventory = {
      findExpiredPreliminaryHoldOrderIds: async (_cutoff: Date, manager: { query: (q: string) => Promise<Array<{ db: string }>> }) => {
        touched.push((await manager.query(`SELECT current_database() AS db`))[0].db);
        return [];
      },
    };
    const scheduler = new PreliminaryHoldExpiryScheduler(inventory as never, { expireHoldForOrder: jest.fn() } as never, h.connections, platform());
    const listSpy = jest.spyOn(h.connections, 'listActiveCompanyIds').mockImplementation(async () => {
      const ids = [h.companyAId, h.companyBId];
      await activation.suspend(h.companyAId); // suspended AFTER the list was built, BEFORE A's turn
      return ids;
    });
    try {
      await scheduler.runOnce();
    } finally {
      listSpy.mockRestore();
    }
    expect(touched).toEqual([h.companyBDbName]);
    expect(getDataSourceSpy).not.toHaveBeenCalledWith(h.companyAId);
  });

  it('SCHEDULED WORK (V-05) — ApprovalExpiryScheduler: a DECOMMISSIONED Company is skipped, the other Company\'s sweep still runs', async () => {
    await activation.suspend(h.companyAId);
    await activation.decommission(h.companyAId);
    const seen: string[] = [];
    const engine = { expire: async (ds: DataSource) => (seen.push(await dbOf(ds)), { expired: 0 }) };
    const scheduler = new ApprovalExpiryScheduler(engine as never, { get: () => true } as never, h.connections, platform());
    await scheduler.runOnce();
    expect(seen).toEqual([h.companyBDbName]);
    expect(getDataSourceSpy).not.toHaveBeenCalledWith(h.companyAId);
  });

  it('BACKUP SEPARATION (V-06 / N-08) — Layer-2 admission does not touch Backup/DR\'s own sweep set: a SUSPENDED Company stays in the registry-based list Backup uses (no implicit bypass, no flag, no change)', async () => {
    await activation.suspend(h.companyAId);
    const backupSweepSet = await h.connections.listActiveCompanyIds();
    expect(backupSweepSet).toContain(h.companyAId);
    expect(backupSweepSet).toContain(h.companyBId);
    expect(await statusOf(h.companyAId)).toBe('SUSPENDED');
  });
});
