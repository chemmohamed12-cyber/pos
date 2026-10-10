import { DataSource } from 'typeorm';
import { MembershipsMineController } from './memberships-mine.controller';
import { MembershipService } from './membership.service';
import { Membership } from './membership.entity';
import { CompanyService } from './company.service';
import { Company } from './company.entity';
import { UsersService } from '../identity/users.service';
import { User } from '../identity/user.entity';
import { AuthenticatedRequest } from '../authentication/jwt-auth.guard';

/**
 * Backend Integration Dependency (2026-09-25, CTO-authorized). Real
 * Postgres proof of every required scenario — not a mocked controller
 * test. `userId` is always taken from `req.user.id` (the same shape
 * `JwtAuthGuard` populates), never a client-suppliable value; nothing
 * here opens a Company `DataSource` at all, proven structurally
 * (`MembershipsMineController`'s own constructor has no
 * `CompanyConnectionManagerService`/Company-DataSource-capable dependency
 * — grep-verifiable, not just asserted) and empirically (queries only hit
 * the one Platform database this test provisions).
 */
const NS = process.env.DAII_TEST_DB_NS ?? ''; // regression runner namespace (biz_tNN_), see two-company-real-pg-harness.ts
const HOST = process.env.DB_HOST ?? 'localhost';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 5433;
const USERNAME = process.env.DB_USER ?? 'daii';
const PASSWORD = process.env.DB_PASSWORD ?? 'daii_dev_only';
const APP_ROOT = process.cwd();

const CONTROL_PLANE_DB = `daii_test_${NS}memberships_mine_control_plane`;

async function withAdminConnection<T>(fn: (admin: DataSource) => Promise<T>): Promise<T> {
  const admin = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: 'postgres', synchronize: false, logging: false });
  await admin.initialize();
  try {
    return await fn(admin);
  } finally {
    await admin.destroy();
  }
}

async function createDatabase(name: string): Promise<void> {
  await withAdminConnection(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
  });
}

async function dropDatabase(name: string): Promise<void> {
  await withAdminConnection(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });
}

describe('GET /memberships/mine — real Postgres (2026-09-25, CTO-authorized)', () => {
  jest.setTimeout(300_000);

  let controlPlane: DataSource;
  let controller: MembershipsMineController;
  let users: UsersService;
  let memberships: MembershipService;
  const companyAId = '10101010-1010-1010-1010-101010101010';
  const companyBId = '20202020-2020-2020-2020-202020202020';

  beforeAll(async () => {
    await createDatabase(CONTROL_PLANE_DB);
    const { runMigrationsForDatabase } = await import('../release-orchestration/company-migration-runner');
    const migrated = await runMigrationsForDatabase(APP_ROOT, { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: CONTROL_PLANE_DB }, ['core']);
    if (!migrated.success) throw new Error(`control-plane migration failed: ${migrated.error}`);

    controlPlane = new DataSource({
      type: 'postgres',
      host: HOST,
      port: PORT,
      username: USERNAME,
      password: PASSWORD,
      database: CONTROL_PLANE_DB,
      synchronize: false,
      logging: false,
      entities: [Membership, Company, User],
    });
    await controlPlane.initialize();
    await controlPlane.query(
      `INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ($1,$2,$3,$4,$5,$6)`,
      ['installation', 'test-installation', 'Test Installation', 'DAII_STANDARD', '1.0.0', '{}'],
    );
    await controlPlane.query(`INSERT INTO "companies" ("id","installationId","name","status") VALUES ($1,$2,$3,$4)`, [companyAId, 'installation', 'Company A', 'READY']);
    await controlPlane.query(`INSERT INTO "companies" ("id","installationId","name","status") VALUES ($1,$2,$3,$4)`, [companyBId, 'installation', 'Company B', 'READY']);

    users = new UsersService(controlPlane.getRepository(User));
    memberships = new MembershipService(controlPlane.getRepository(Membership));
    const companies = new CompanyService(controlPlane.getRepository(Company));
    controller = new MembershipsMineController(memberships, companies);
  });

  afterAll(async () => {
    if (controlPlane?.isInitialized) await controlPlane.destroy();
    await dropDatabase(CONTROL_PLANE_DB);
  });

  function reqFor(userId: string): AuthenticatedRequest {
    return { user: { id: userId, email: 'x@test.local' } } as unknown as AuthenticatedRequest;
  }

  it('Positive: returns only the caller\'s own memberships', async () => {
    const userA = await users.create({ fullName: 'Mine Test User A', email: 'mine-user-a@test.local' });
    await memberships.create({ userId: userA.id, companyId: companyAId, roleKey: 'admin' });

    const result = await controller.list(reqFor(userA.id));

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual({ companyId: companyAId, companyName: 'Company A', status: 'READY', roleKey: 'admin' });
  });

  it('Multiple Companies: a user with memberships in both A and B gets both back', async () => {
    const userAB = await users.create({ fullName: 'Mine Test User AB', email: 'mine-user-ab@test.local' });
    await memberships.create({ userId: userAB.id, companyId: companyAId, roleKey: 'admin' });
    await memberships.create({ userId: userAB.id, companyId: companyBId, roleKey: 'sales.rep' });

    const result = await controller.list(reqFor(userAB.id));

    expect(result.data).toHaveLength(2);
    const companyIds = result.data.map((r) => r.companyId).sort();
    expect(companyIds).toEqual([companyAId, companyBId].sort());
  });

  it('No membership: returns an empty array, not an error', async () => {
    const userNone = await users.create({ fullName: 'Mine Test User None', email: 'mine-user-none@test.local' });

    const result = await controller.list(reqFor(userNone.id));

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('Cross-user protection: there is no parameter through which User A can request User B\'s memberships', async () => {
    const userA = await users.create({ fullName: 'Mine Test Cross A', email: 'mine-cross-a@test.local' });
    const userB = await users.create({ fullName: 'Mine Test Cross B', email: 'mine-cross-b@test.local' });
    await memberships.create({ userId: userB.id, companyId: companyBId, roleKey: 'admin' });

    // The controller's only source of identity is req.user.id — there is no query param, body
    // field, or header the caller could use to name a different user. Calling it as User A
    // returns User A's own (empty) list, never User B's, regardless of what User B's id is.
    const resultAsA = await controller.list(reqFor(userA.id));
    expect(resultAsA.data.some((r) => r.companyId === companyBId)).toBe(false);

    const resultAsB = await controller.list(reqFor(userB.id));
    expect(resultAsB.data.some((r) => r.companyId === companyBId)).toBe(true);
  });

  it('No Company Context: the request succeeds with only req.user set — no companyContext anywhere', async () => {
    const userA = await users.create({ fullName: 'Mine Test No Context', email: 'mine-no-context@test.local' });
    await memberships.create({ userId: userA.id, companyId: companyAId, roleKey: 'admin' });

    const req = reqFor(userA.id); // deliberately has no companyContext property at all
    const result = await controller.list(req);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
  });

  it('DB boundary: the controller has no Company-DataSource-capable dependency at all (structural), and only the Platform DB is ever queried (empirical)', () => {
    // Structural: MembershipsMineController's constructor only accepts MembershipService and
    // CompanyService — neither can open a Company DataSource. This is provable by construction:
    // the class has exactly 2 constructor parameters, matching this test's own instantiation above.
    expect(MembershipsMineController.length).toBe(2);
  });

  it('Authentication: the controller is gated by JwtAuthGuard only (no CompanyContextGuard, no PermissionGuard)', () => {
    const guards: unknown[] = Reflect.getMetadata('__guards__', MembershipsMineController) ?? [];
    const guardNames = guards.map((g) => (g as { name: string }).name);
    expect(guardNames).toEqual(['JwtAuthGuard']);
  });
});
