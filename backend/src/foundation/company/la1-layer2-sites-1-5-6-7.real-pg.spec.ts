import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { CompanyActivationService } from './company-activation.service';
import { CompanyRegistryService } from './company-registry.service';
import { MembershipReconciliationScheduler } from './membership-reconciliation.scheduler';
import type { MembershipOperation } from './membership-operation.entity';
import type { MembershipOperationService } from './membership-operation.service';
// Test-only: this spec proves the lifecycle-admission boundary on the REAL scheduler class of another domain; there is no published contract for it (same documented pattern as company-lifecycle-admission.real-pg.spec.ts).
// eslint-disable-next-line no-restricted-imports
import { ClosingSnapshotRecoveryScheduler } from '../../domains/accounting/application/closing-snapshot-recovery.scheduler';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';

/**
 * LA-1 — Layer 2 lifecycle admission, tracker sites 1, 5, 6 and 7 (authorised by the CTO on 2026-10-14): REAL-POSTGRES + two-Company proof.
 *   site 1  ClosingSnapshotRecoveryScheduler           (per-Company sweep that writes Company data)
 *   site 5  MembershipReconciliationScheduler role_set (reads Company roles to heal the platform mirror)
 *   site 6  MembershipReconciliationScheduler grant with `targetRoleKeys` (replay in one Company transaction)
 *   site 7  MembershipReconciliationScheduler grant / revoke / role_change retry
 * Per site: POSITIVE (READY → the work runs against that Company's own database), NEGATIVE (not READY → no Company DataSource is requested, no Company row changes, the operation is
 * left untouched: still FAILED, `attempts` not incremented), ISOLATION (A suspended, B still served), LIFECYCLE (A resumes → the deferred work is applied exactly once).
 * Real: Platform `companies` row locks, `CompanyActivationService.suspend`, the real CompanyConnectionManagerService, two real Company databases, the real schedulers, the real
 * MembershipService / UsersService. Doubles (declared): the closing-snapshot service (records which database it was handed), the membership-operation ledger (an in-memory
 * stand-in with the real state transitions) and the audit writer (a no-op: audit is proven elsewhere).
 */
describe('LA-1 Layer 2 — sites 1, 5, 6, 7 (schedulers), real-Postgres + A/B isolation', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let activation: CompanyActivationService;
  let getDataSourceSpy: jest.SpyInstance;

  const setStatus = (id: string, status: string) => h.controlPlane.query(`UPDATE "companies" SET "status" = $1 WHERE "id" = $2`, [status, id]);
  const dbOfCompany = (id: string) => (id === h.companyAId ? h.companyADbName : h.companyBDbName);

  /** Direct, separate connection to a Company database — used only to INSPECT or SEED state without touching the spied connection manager. */
  async function peek<T = Record<string, string>>(companyId: string, sql: string, params: unknown[] = []): Promise<T[]> {
    const o = h.controlPlane.options as { host: string; port: number; username: string; password: string };
    const ds = new DataSource({ type: 'postgres', host: o.host, port: o.port, username: o.username, password: o.password, database: dbOfCompany(companyId), synchronize: false, logging: false });
    await ds.initialize();
    try {
      return (await ds.query(sql, params)) as T[];
    } finally {
      await ds.destroy();
    }
  }
  const roleRows = (companyId: string, userId: string) =>
    peek<{ key: string }>(companyId, `SELECT r."key" FROM "user_roles" ur JOIN "roles" r ON r.id = ur."roleId" WHERE ur."userId" = $1 ORDER BY r."key"`, [userId]).then((rows) => rows.map((r) => r.key));
  const seedRole = (companyId: string, userId: string, key: string) =>
    peek(companyId, `INSERT INTO "user_roles" ("id","userId","roleId") VALUES (gen_random_uuid(), $1, (SELECT id FROM "roles" WHERE "key" = $2))`, [userId, key]);

  // ---- in-memory membership-operation ledger with the real state transitions ----
  let ops: MembershipOperation[];
  const operations = {
    findRetryable: async (max: number) => ops.filter((o) => o.status === 'FAILED' && o.attempts < max),
    markRetrying: async (id: string) => { ops.find((o) => o.id === id)!.status = 'RETRYING'; },
    markCompleted: async (id: string) => { ops.find((o) => o.id === id)!.status = 'COMPLETED'; },
    markFailed: async (id: string, error: string) => { const o = ops.find((x) => x.id === id)!; o.status = 'FAILED'; o.attempts += 1; o.lastError = error; },
  };
  const newOp = (partial: Partial<MembershipOperation> & Pick<MembershipOperation, 'userId' | 'companyId' | 'operationType'>): MembershipOperation => {
    const op = { id: randomUUID(), previousRoleKey: null, targetRoleKey: null, targetRoleKeys: null, status: 'FAILED', attempts: 1, lastError: 'simulated', correlationId: randomUUID(), ...partial } as unknown as MembershipOperation;
    ops.push(op);
    return op;
  };
  const statusOf = (op: MembershipOperation) => ({ status: op.status, attempts: op.attempts });
  const membershipScheduler = () => new MembershipReconciliationScheduler(operations as unknown as MembershipOperationService, h.memberships, h.connections, { record: jest.fn() } as never, h.controlPlane);
  const newUser = async (tag: string) => (await h.users.create({ fullName: `LA1 ${tag}`, email: `la1-${tag}-${randomUUID().slice(0, 8)}@test.local` })).id;
  const calledWithCompany = (id: string) => getDataSourceSpy.mock.calls.some((c) => c[0] === id);

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'la1_sites_1567', roleModuleCodes: ['sales'] });
    activation = new CompanyActivationService(new CompanyRegistryService(h.companies));
    getDataSourceSpy = jest.spyOn(h.connections, 'getDataSource');
  });

  afterAll(async () => {
    await h.teardown();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    getDataSourceSpy = jest.spyOn(h.connections, 'getDataSource');
    await setStatus(h.companyAId, 'READY');
    await setStatus(h.companyBId, 'READY');
    ops = [];
  });

  // =============================== SITE 1 — ClosingSnapshotRecoveryScheduler ===============================
  describe('site 1 — ClosingSnapshotRecoveryScheduler', () => {
    const makeScheduler = (touched: string[]) => {
      const snapshots = {
        retryPending: async (manager: { query: (q: string) => Promise<Array<{ db: string }>> }) => { touched.push((await manager.query(`SELECT current_database() AS db`))[0].db); },
        detectOverdue: async () => [],
      };
      return new ClosingSnapshotRecoveryScheduler(snapshots as never, h.connections, h.controlPlane);
    };

    it('POSITIVE — both Companies READY: each is swept once, against its own database', async () => {
      const touched: string[] = [];
      jest.spyOn(h.connections, 'listActiveCompanyIds').mockResolvedValue([h.companyAId, h.companyBId]);
      await makeScheduler(touched).runOnce();
      expect(touched.sort()).toEqual([h.companyADbName, h.companyBDbName].sort());
    });

    it('NEGATIVE + ISOLATION — A SUSPENDED: A\'s database is never requested or touched; B is still swept', async () => {
      const touched: string[] = [];
      jest.spyOn(h.connections, 'listActiveCompanyIds').mockResolvedValue([h.companyAId, h.companyBId]);
      await activation.suspend(h.companyAId);
      await makeScheduler(touched).runOnce();
      expect(touched).toEqual([h.companyBDbName]);
      expect(calledWithCompany(h.companyAId)).toBe(false);
    });

    it('LIFECYCLE — A was READY when the sweep list was built but is SUSPENDED when its turn comes: skipped; after it resumes the next sweep covers it exactly once', async () => {
      const touched: string[] = [];
      jest.spyOn(h.connections, 'listActiveCompanyIds').mockImplementationOnce(async () => {
        await activation.suspend(h.companyAId); // the list is built while A is READY, then A is suspended before its turn
        return [h.companyAId, h.companyBId];
      });
      const scheduler = makeScheduler(touched);
      await scheduler.runOnce();
      expect(touched).toEqual([h.companyBDbName]);
      expect(calledWithCompany(h.companyAId)).toBe(false);

      await setStatus(h.companyAId, 'READY');
      touched.length = 0;
      jest.spyOn(h.connections, 'listActiveCompanyIds').mockResolvedValue([h.companyAId]);
      await scheduler.runOnce();
      expect(touched).toEqual([h.companyADbName]);
    });
  });

  // =============================== SITE 5 — role_set (mirror heal) ===============================
  describe('site 5 — MembershipReconciliationScheduler role_set', () => {
    it('NEGATIVE → LIFECYCLE — A SUSPENDED: the mirror is not healed, the operation stays FAILED with attempts unchanged, A\'s database is never requested; after READY it is healed once', async () => {
      const userId = await newUser('s5');
      await h.memberships.create({ userId, companyId: h.companyAId, roleKey: 'stale' });
      await seedRole(h.companyAId, userId, 'sales.manager'); // the Company DB is the authority
      const op = newOp({ userId, companyId: h.companyAId, operationType: 'role_set' });

      await activation.suspend(h.companyAId);
      await membershipScheduler().runOnce();
      expect((await h.memberships.findByUserAndCompany(userId, h.companyAId))?.roleKey).toBe('stale');
      expect(statusOf(op)).toEqual({ status: 'FAILED', attempts: 1 });
      expect(calledWithCompany(h.companyAId)).toBe(false);

      await setStatus(h.companyAId, 'READY');
      await membershipScheduler().runOnce();
      expect((await h.memberships.findByUserAndCompany(userId, h.companyAId))?.roleKey).toBe('sales.manager');
      expect(statusOf(op).status).toBe('COMPLETED');
    });
  });

  // =============================== SITE 6 — grant with targetRoleKeys (replay in one Company transaction) ===============================
  describe('site 6 — MembershipReconciliationScheduler grant with targetRoleKeys', () => {
    it('POSITIVE — A READY: the full role set is replayed into A\'s database, the operation completes', async () => {
      const userId = await newUser('s6p');
      await h.memberships.create({ userId, companyId: h.companyAId, roleKey: 'sales.rep' });
      const op = newOp({ userId, companyId: h.companyAId, operationType: 'grant', targetRoleKey: 'sales.rep', targetRoleKeys: ['sales.rep', 'sales.manager'] });
      await membershipScheduler().runOnce();
      expect(await roleRows(h.companyAId, userId)).toEqual(['sales.manager', 'sales.rep']);
      expect(statusOf(op).status).toBe('COMPLETED');
    });

    it('NEGATIVE → LIFECYCLE — A SUSPENDED: no role row is written, the operation is untouched, A\'s database is never requested; after READY the replay is applied exactly once', async () => {
      const userId = await newUser('s6n');
      await h.memberships.create({ userId, companyId: h.companyAId, roleKey: 'sales.rep' });
      const op = newOp({ userId, companyId: h.companyAId, operationType: 'grant', targetRoleKey: 'sales.rep', targetRoleKeys: ['sales.rep'] });

      await activation.suspend(h.companyAId);
      await membershipScheduler().runOnce();
      expect(await roleRows(h.companyAId, userId)).toEqual([]);
      expect(statusOf(op)).toEqual({ status: 'FAILED', attempts: 1 });
      expect(calledWithCompany(h.companyAId)).toBe(false);

      await setStatus(h.companyAId, 'READY');
      await membershipScheduler().runOnce();
      await membershipScheduler().runOnce(); // a second sweep must not apply it again (the operation is COMPLETED, and the grant is idempotent anyway)
      expect(await roleRows(h.companyAId, userId)).toEqual(['sales.rep']);
      expect(statusOf(op).status).toBe('COMPLETED');
    });
  });

  // =============================== SITE 7 — grant / revoke / role_change retry ===============================
  describe('site 7 — MembershipReconciliationScheduler grant / revoke / role_change', () => {
    it('grant — NEGATIVE → LIFECYCLE: nothing written while A is SUSPENDED; applied once after READY', async () => {
      const userId = await newUser('s7g');
      await h.memberships.create({ userId, companyId: h.companyAId, roleKey: 'sales.rep' });
      const op = newOp({ userId, companyId: h.companyAId, operationType: 'grant', targetRoleKey: 'sales.rep' });
      await activation.suspend(h.companyAId);
      await membershipScheduler().runOnce();
      expect(await roleRows(h.companyAId, userId)).toEqual([]);
      expect(statusOf(op)).toEqual({ status: 'FAILED', attempts: 1 });
      expect(calledWithCompany(h.companyAId)).toBe(false);
      await setStatus(h.companyAId, 'READY');
      await membershipScheduler().runOnce();
      expect(await roleRows(h.companyAId, userId)).toEqual(['sales.rep']);
      expect(statusOf(op).status).toBe('COMPLETED');
    });

    it('revoke — NEGATIVE → LIFECYCLE: the role row stays while A is SUSPENDED (no half state); removed once after READY', async () => {
      const userId = await newUser('s7r');
      await seedRole(h.companyAId, userId, 'sales.rep'); // the membership was already removed on the platform side; only the Company-side cleanup is pending
      const op = newOp({ userId, companyId: h.companyAId, operationType: 'revoke', previousRoleKey: 'sales.rep' });
      await activation.suspend(h.companyAId);
      await membershipScheduler().runOnce();
      expect(await roleRows(h.companyAId, userId)).toEqual(['sales.rep']);
      expect(statusOf(op)).toEqual({ status: 'FAILED', attempts: 1 });
      expect(calledWithCompany(h.companyAId)).toBe(false);
      await setStatus(h.companyAId, 'READY');
      await membershipScheduler().runOnce();
      expect(await roleRows(h.companyAId, userId)).toEqual([]);
      expect(statusOf(op).status).toBe('COMPLETED');
    });

    it('role_change — NEGATIVE → LIFECYCLE: neither the old role is removed nor the new one added while A is SUSPENDED; both applied in one transaction after READY', async () => {
      const userId = await newUser('s7c');
      await h.memberships.create({ userId, companyId: h.companyAId, roleKey: 'sales.rep' });
      await seedRole(h.companyAId, userId, 'sales.manager');
      const op = newOp({ userId, companyId: h.companyAId, operationType: 'role_change', previousRoleKey: 'sales.manager', targetRoleKey: 'sales.rep' });
      await activation.suspend(h.companyAId);
      await membershipScheduler().runOnce();
      expect(await roleRows(h.companyAId, userId)).toEqual(['sales.manager']);
      expect(statusOf(op)).toEqual({ status: 'FAILED', attempts: 1 });
      await setStatus(h.companyAId, 'READY');
      await membershipScheduler().runOnce();
      expect(await roleRows(h.companyAId, userId)).toEqual(['sales.rep']);
      expect(statusOf(op).status).toBe('COMPLETED');
    });

    it('ISOLATION — operations of A and B in the same sweep: A SUSPENDED is deferred, B is applied against B\'s database only', async () => {
      const ua = await newUser('s7ia');
      const ub = await newUser('s7ib');
      await h.memberships.create({ userId: ua, companyId: h.companyAId, roleKey: 'sales.rep' });
      await h.memberships.create({ userId: ub, companyId: h.companyBId, roleKey: 'sales.rep' });
      const opA = newOp({ userId: ua, companyId: h.companyAId, operationType: 'grant', targetRoleKey: 'sales.rep' });
      const opB = newOp({ userId: ub, companyId: h.companyBId, operationType: 'grant', targetRoleKey: 'sales.rep' });
      await activation.suspend(h.companyAId);
      await membershipScheduler().runOnce();
      expect(await roleRows(h.companyBId, ub)).toEqual(['sales.rep']);
      expect(await roleRows(h.companyAId, ua)).toEqual([]);
      expect(statusOf(opB).status).toBe('COMPLETED');
      expect(statusOf(opA)).toEqual({ status: 'FAILED', attempts: 1 });
      expect(calledWithCompany(h.companyAId)).toBe(false);
      expect(calledWithCompany(h.companyBId)).toBe(true);
    });

    it('a failing admitted operation is still recorded as a failure (attempts + 1) and does not stop the sweep — the error path is unchanged', async () => {
      const userId = await newUser('s7f');
      await h.memberships.create({ userId, companyId: h.companyAId, roleKey: 'no.such.role' });
      const bad = newOp({ userId, companyId: h.companyAId, operationType: 'grant', targetRoleKey: 'no.such.role' }); // role not seeded → RoleNotSeededError inside the admitted work
      const ub = await newUser('s7fb');
      await h.memberships.create({ userId: ub, companyId: h.companyBId, roleKey: 'sales.rep' });
      const good = newOp({ userId: ub, companyId: h.companyBId, operationType: 'grant', targetRoleKey: 'sales.rep' });
      await membershipScheduler().runOnce();
      expect(statusOf(bad)).toEqual({ status: 'FAILED', attempts: 2 });
      expect(statusOf(good).status).toBe('COMPLETED');
    });
  });
});
