import { DataSource } from 'typeorm';
import { CompanyMembershipProvisioningService } from './company-membership-provisioning.service';
import { MembershipReconciliationScheduler } from './membership-reconciliation.scheduler';
import { MembershipService } from './membership.service';
import { Membership } from './membership.entity';
import { MembershipOperationService } from './membership-operation.service';
import { MembershipOperation } from './membership-operation.entity';
import { UsersService } from '../identity/users.service';
import { User } from '../identity/user.entity';
import { AuditService } from '../audit/audit.service';
import { AuditRecord } from '../audit/audit-record.entity';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { DatabaseCredential } from '../database-registry/database-credential.entity';
import { DatabaseCredentialCipherService } from '../database-registry/database-credential-cipher.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { AppConfigService } from '../configuration/app-config.service';
import { applyCompanyAuthorizationSchemaAdjustment } from './company-authorization-schema-adjustment';
import { seedCompanyRoleTemplates, seedCompanyAdminRole } from './company-role-seeding';

/**
 * ADR-073 §6 — Track A Targeted Re-Verification (CTO Decision, Option D,
 * 2026-09-25). Real, disposable Postgres proof that the invariant now
 * holds end to end:
 *
 *   Platform User validation → Company Membership validation →
 *   Company DB routing → UserRole write
 *
 * for the exact live paths that share `provisionUserRoleForMembership`
 * with Area 4: `grantMembership`, `changeMembershipRole`, and
 * `MembershipReconciliationScheduler`'s replay of `grant`/`role_change`.
 * `revokeMembership` is deliberately NOT re-verified here — ADR-073 §3/§7
 * already established it is a `DELETE`, never subject to the FK this
 * whole investigation is about.
 *
 * This is a companion to `database-provisioning.service.spec.ts` (Area 4)
 * — that file proves the FK adjustment itself; this file proves Track A's
 * own services, previously only proven against mocks
 * (`company-membership-provisioning.service.spec.ts` mocks
 * `membership-role-provisioning` entirely), now work for real.
 */
const NS = process.env.DAII_TEST_DB_NS ?? ''; // regression runner namespace (biz_tNN_), see two-company-real-pg-harness.ts
const HOST = process.env.DB_HOST ?? 'localhost';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 5433;
const USERNAME = process.env.DB_USER ?? 'daii';
const PASSWORD = process.env.DB_PASSWORD ?? 'daii_dev_only';
const APP_ROOT = process.cwd();

const CONTROL_PLANE_DB = `daii_test_${NS}adr073_control_plane`;
const COMPANY_DB = `daii_test_${NS}adr073_company`;

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

describe('Track A live grant paths — ADR-073 §6 targeted re-verification, real disposable Postgres', () => {
  jest.setTimeout(300_000);

  let controlPlane: DataSource;
  let companyId: string;
  let provisioning: CompanyMembershipProvisioningService;
  let scheduler: MembershipReconciliationScheduler;
  let memberships: MembershipService;
  let operations: MembershipOperationService;
  let users: UsersService;
  let connections: CompanyConnectionManagerService;

  beforeAll(async () => {
    await createDatabase(CONTROL_PLANE_DB);
    await createDatabase(COMPANY_DB);

    const { runMigrationsForDatabase } = await import('../release-orchestration/company-migration-runner');
    const migratedControlPlane = await runMigrationsForDatabase(APP_ROOT, { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: CONTROL_PLANE_DB }, ['core']);
    if (!migratedControlPlane.success) throw new Error(`control-plane migration failed: ${migratedControlPlane.error}`);

    const companyDatabaseConfig = { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: COMPANY_DB };
    const migratedCompany = await runMigrationsForDatabase(APP_ROOT, companyDatabaseConfig, ['core']);
    if (!migratedCompany.success) throw new Error(`company migration failed: ${migratedCompany.error}`);
    // The exact sequence ADR-073 Option D authorizes: migrations (unmodified) -> Company-only FK adjustment -> role seeding.
    await applyCompanyAuthorizationSchemaAdjustment(companyDatabaseConfig);
    await seedCompanyRoleTemplates(companyDatabaseConfig, ['sales']);
    await seedCompanyAdminRole(companyDatabaseConfig, ['sales']);

    controlPlane = new DataSource({
      type: 'postgres',
      host: HOST,
      port: PORT,
      username: USERNAME,
      password: PASSWORD,
      database: CONTROL_PLANE_DB,
      synchronize: false,
      logging: false,
      entities: [Membership, MembershipOperation, User, AuditRecord, DatabaseRegistry, DatabaseCredential],
    });
    await controlPlane.initialize();

    // Installation FK prerequisite (same as the Area 4 spec's own setup) — normally written by
    // the Entitlement apply endpoint, not a migration.
    await controlPlane.query(
      `INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ($1,$2,$3,$4,$5,$6)`,
      ['installation', 'test-installation', 'Test Installation', 'DAII_STANDARD', '1.0.0', '{}'],
    );
    companyId = '11111111-1111-1111-1111-111111111111';
    await controlPlane.query(`INSERT INTO "companies" ("id","installationId","name","status") VALUES ($1,$2,$3,$4)`, [companyId, 'installation', 'Track A Real-PG Co', 'READY']);

    const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as unknown as AppConfigService);
    const databaseRegistry = new DatabaseRegistryService(controlPlane.getRepository(DatabaseRegistry), controlPlane.getRepository(DatabaseCredential), cipher);
    await databaseRegistry.register({ companyId, host: HOST, port: PORT, databaseName: COMPANY_DB, status: 'ACTIVE' }, JSON.stringify({ username: USERNAME, password: PASSWORD }));

    connections = new CompanyConnectionManagerService(databaseRegistry);
    memberships = new MembershipService(controlPlane.getRepository(Membership));
    operations = new MembershipOperationService(controlPlane.getRepository(MembershipOperation));
    users = new UsersService(controlPlane.getRepository(User));
    const audit = new AuditService(controlPlane);
    provisioning = new CompanyMembershipProvisioningService(memberships, connections, operations, users, audit);
    scheduler = new MembershipReconciliationScheduler(operations, memberships, connections, audit, controlPlane);
  });

  afterAll(async () => {
    await connections.onModuleDestroy();
    await controlPlane.destroy();
    await dropDatabase(CONTROL_PLANE_DB);
    await dropDatabase(COMPANY_DB);
  });

  async function companyRoleRows(query: string, params: unknown[] = []): Promise<Array<Record<string, string>>> {
    const ds = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: COMPANY_DB, synchronize: false, logging: false });
    await ds.initialize();
    try {
      return await ds.query(query, params);
    } finally {
      await ds.destroy();
    }
  }

  it('grantMembership: Platform User validation -> Company Membership -> real Company-DB UserRole write', async () => {
    const admin = await users.create({ fullName: 'Track A User 1', email: 'tracka-user1@test.local' });

    const membership = await provisioning.grantMembership(null, admin.id, companyId, 'sales.manager');
    expect(membership.roleKey).toBe('sales.manager');

    const rows = await companyRoleRows(
      `SELECT count(*)::text AS count FROM "user_roles" ur JOIN "roles" r ON r.id = ur."roleId" WHERE ur."userId" = $1 AND r."key" = 'sales.manager'`,
      [admin.id],
    );
    expect(Number(rows[0].count)).toBe(1);

    const opRows = await controlPlane.query(`SELECT status FROM "membership_operations" WHERE "userId" = $1 AND "companyId" = $2 AND "operationType" = 'grant' ORDER BY "createdAt" DESC LIMIT 1`, [admin.id, companyId]);
    expect(opRows[0].status).toBe('COMPLETED');
  });

  it('grantMembership rejects an unknown Platform User BEFORE any Company-DB write (negative integrity proof)', async () => {
    const unknownUserId = '00000000-0000-0000-0000-000000000001';
    await expect(provisioning.grantMembership(null, unknownUserId, companyId, 'sales.rep')).rejects.toThrow();

    const rows = await companyRoleRows(`SELECT count(*)::text AS count FROM "user_roles" WHERE "userId" = $1`, [unknownUserId]);
    expect(Number(rows[0].count)).toBe(0);
  });

  it('changeMembershipRole: real Company-DB transaction (deprovision old + provision new) succeeds', async () => {
    const admin = await users.create({ fullName: 'Track A User 2', email: 'tracka-user2@test.local' });
    await provisioning.grantMembership(null, admin.id, companyId, 'sales.manager');

    const updated = await provisioning.changeMembershipRole(null, admin.id, companyId, 'sales.rep');
    expect(updated.roleKey).toBe('sales.rep');

    const oldRoleRows = await companyRoleRows(
      `SELECT count(*)::text AS count FROM "user_roles" ur JOIN "roles" r ON r.id = ur."roleId" WHERE ur."userId" = $1 AND r."key" = 'sales.manager'`,
      [admin.id],
    );
    expect(Number(oldRoleRows[0].count)).toBe(0);

    const newRoleRows = await companyRoleRows(
      `SELECT count(*)::text AS count FROM "user_roles" ur JOIN "roles" r ON r.id = ur."roleId" WHERE ur."userId" = $1 AND r."key" = 'sales.rep'`,
      [admin.id],
    );
    expect(Number(newRoleRows[0].count)).toBe(1);
  });

  it('MembershipReconciliationScheduler replays a stale FAILED "grant" operation and completes it against the real Company DB', async () => {
    const admin = await users.create({ fullName: 'Track A User 3', email: 'tracka-user3@test.local' });
    await memberships.create({ userId: admin.id, companyId, roleKey: 'sales.rep' });
    const op = await operations.start(admin.id, companyId, 'grant', null, 'sales.rep');
    await operations.markFailed(op.id, 'simulated transient failure');

    await scheduler.runOnce();

    const rows = await companyRoleRows(
      `SELECT count(*)::text AS count FROM "user_roles" ur JOIN "roles" r ON r.id = ur."roleId" WHERE ur."userId" = $1 AND r."key" = 'sales.rep'`,
      [admin.id],
    );
    expect(Number(rows[0].count)).toBe(1);

    const opRows = await controlPlane.query(`SELECT status FROM "membership_operations" WHERE "id" = $1`, [op.id]);
    expect(opRows[0].status).toBe('COMPLETED');
  });

  it('MembershipReconciliationScheduler replays a stale FAILED "role_change" operation and completes it against the real Company DB', async () => {
    const admin = await users.create({ fullName: 'Track A User 4', email: 'tracka-user4@test.local' });
    await provisioning.grantMembership(null, admin.id, companyId, 'sales.manager');
    await memberships.updateRole(admin.id, companyId, 'sales.rep');
    const op = await operations.start(admin.id, companyId, 'role_change', 'sales.manager', 'sales.rep');
    await operations.markFailed(op.id, 'simulated transient failure');

    await scheduler.runOnce();

    const newRoleRows = await companyRoleRows(
      `SELECT count(*)::text AS count FROM "user_roles" ur JOIN "roles" r ON r.id = ur."roleId" WHERE ur."userId" = $1 AND r."key" = 'sales.rep'`,
      [admin.id],
    );
    expect(Number(newRoleRows[0].count)).toBe(1);

    const opRows = await controlPlane.query(`SELECT status FROM "membership_operations" WHERE "id" = $1`, [op.id]);
    expect(opRows[0].status).toBe('COMPLETED');
  });
});
