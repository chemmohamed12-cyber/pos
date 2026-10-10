import { DataSource } from 'typeorm';
import { DatabaseProvisioningService, ProvisioningFailedError } from './database-provisioning.service';
import { CompanyService } from '../company/company.service';
import { CompanyRegistryService } from '../company/company-registry.service';
import { Company } from '../company/company.entity';
import { MembershipService } from '../company/membership.service';
import { Membership } from '../company/membership.entity';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { DatabaseCredential } from '../database-registry/database-credential.entity';
import { DatabaseCredentialCipherService } from '../database-registry/database-credential-cipher.service';
import { AppConfigService } from '../configuration/app-config.service';
import { UsersService } from '../identity/users.service';
import { User } from '../identity/user.entity';

/**
 * V7 Area 4's own Verification requirement: "End-to-end provisioning test
 * against a real, disposable Postgres instance." Real Control-Plane
 * database (Company/DatabaseRegistry/DatabaseCredential tables, migrated
 * for real) plus a real, separate disposable Company database that
 * provisioning actually migrates and health-checks — nothing mocked
 * below the service layer.
 *
 * V7 Area 4 (2026-09-25) — the environment blocker is CLEARED: `daii`
 * was granted `CREATEDB` on this Postgres instance (verified via
 * `pg_roles.rolcreatedb = true`), so this suite now runs for real. See
 * `database-provisioning.service.unit.spec.ts` for the mocked,
 * logic-only coverage that ran throughout the blocked period as
 * supplementary (not equivalent) evidence.
 */
const NS = process.env.DAII_TEST_DB_NS ?? ''; // regression runner namespace (biz_tNN_), see two-company-real-pg-harness.ts
const HOST = process.env.DB_HOST ?? 'localhost';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 5433;
const USERNAME = process.env.DB_USER ?? 'daii';
const PASSWORD = process.env.DB_PASSWORD ?? 'daii_dev_only';
const APP_ROOT = process.cwd();

const CONTROL_PLANE_DB = `daii_test_${NS}area4_control_plane`;
const COMPANY_DB = `daii_test_${NS}area4_company`;
// One physical database belongs to exactly ONE Company (unique index on database_registries.databaseName), so each test that provisions its own Company gets its own database.
const EXTRA_DBS = [`daii_test_${NS}area4_company_unknown_admin`, `daii_test_${NS}area4_company_retry`];
const INSTALLATION_ID = 'installation';

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

describe('DatabaseProvisioningService (Area 4 + Area 16 joint unit, real disposable Postgres)', () => {
  jest.setTimeout(300_000);

  let controlPlane: DataSource;
  let service: DatabaseProvisioningService;
  let companyRegistry: CompanyRegistryService;
  let adminUserId: string;

  beforeAll(async () => {
    await createDatabase(CONTROL_PLANE_DB);
    await createDatabase(COMPANY_DB);
    for (const d of EXTRA_DBS) await createDatabase(d);

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
      // Real disposable DataSource (not AppModule's TypeOrmModule.forRoot, which registers
      // entities automatically) — every entity this spec's repositories touch must be listed
      // explicitly or `getRepository()` cannot resolve metadata (2026-09-25 technical finding:
      // first real run after the CREATEDB blocker cleared surfaced this missing list).
      entities: [Company, DatabaseRegistry, DatabaseCredential, Membership, User],
    });
    await controlPlane.initialize();

    // Installation FK prerequisite — normally written by the Entitlement apply endpoint, not a migration.
    await controlPlane.query(
      `INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ($1,$2,$3,$4,$5,$6)`,
      [INSTALLATION_ID, 'test-installation', 'Test Installation', 'DAII_STANDARD', '1.0.0', '{}'],
    );

    const companyService = new CompanyService(controlPlane.getRepository(Company));
    companyRegistry = new CompanyRegistryService(companyService);
    const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as unknown as AppConfigService);
    const databaseRegistry = new DatabaseRegistryService(controlPlane.getRepository(DatabaseRegistry), controlPlane.getRepository(DatabaseCredential), cipher);
    const memberships = new MembershipService(controlPlane.getRepository(Membership));
    const users = new UsersService(controlPlane.getRepository(User));
    service = new DatabaseProvisioningService(companyRegistry, databaseRegistry, memberships, users);

    // Area 20 (D1) — the initial-admin step requires an EXISTING User; created once here, real, not mocked.
    const admin = await users.create({ fullName: 'Test Admin', email: 'area20-admin@test.local' });
    adminUserId = admin.id;
  });

  afterAll(async () => {
    await controlPlane.destroy();
    await dropDatabase(CONTROL_PLANE_DB);
    await dropDatabase(COMPANY_DB);
    for (const d of EXTRA_DBS) await dropDatabase(d);
  });

  it('provisions a Company end-to-end: registers the database, migrates it, health-checks it, marks READY (proof points 1, 2, 7)', async () => {
    const company = await companyRegistry.provision(INSTALLATION_ID, 'Acme Egypt');

    const result = await service.provision({
      companyId: company.id,
      host: HOST,
      port: PORT,
      databaseName: COMPANY_DB,
      username: USERNAME,
      password: PASSWORD,
      appRoot: APP_ROOT,
      tags: ['core'],
      roleModuleCodes: ['sales'],
      initialAdminUserId: adminUserId,
    });

    expect(result.readyMarked).toBe(true);
    expect(result.migratedNames.length).toBeGreaterThan(0);
    expect(result.roleSeedResult.roles).toBeGreaterThan(0);
    expect(result.healthCheck?.ok).toBe(true);
    expect(result.registry.companyId).toBe(company.id);
    expect(result.registry.host).toBe(HOST);
    expect(result.registry.databaseName).toBe(COMPANY_DB);

    const updatedCompany = await companyRegistry.findById(company.id);
    expect(updatedCompany?.status).toBe('READY');

    // Proof point 1/2 — the company database was actually migrated, and the registry reflects it.
    const companyDs = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: COMPANY_DB, synchronize: false, logging: false });
    await companyDs.initialize();
    try {
      const rows: Array<{ to_regclass: string | null }> = await companyDs.query(`SELECT to_regclass('public.users') AS to_regclass`);
      expect(rows[0]?.to_regclass).not.toBeNull();
      // Area 6 — role templates were actually seeded into THIS company's own database.
      const roleRows: Array<{ key: string }> = await companyDs.query(`SELECT "key" FROM "roles" WHERE "key" LIKE 'sales.%'`);
      expect(roleRows.length).toBeGreaterThan(0);
      // Area 20 — the initial admin's UserRole was actually granted inside THIS company's own database. CTO Decision 3 (2026-10-07): the default
      // administrator is `company_admin`, and the legacy `admin` role is NOT granted to the initial administrator.
      const grantCount = async (roleKey: string): Promise<number> =>
        Number(
          (
            await companyDs.query(
              `SELECT count(*)::text AS count FROM "user_roles" ur JOIN "roles" r ON r.id = ur."roleId" WHERE ur."userId" = $1 AND r."key" = $2`,
              [adminUserId, roleKey],
            )
          )[0].count,
        );
      expect(await grantCount('company_admin')).toBe(1);
      expect(await grantCount('admin')).toBe(0);

      // ADR-073 Option D — the Company DB's own user_roles FK to its local
      // users table is genuinely gone (not just working around a still-present
      // constraint) — real proof, not an inference from the insert succeeding.
      const fkRows: Array<{ conname: string }> = await companyDs.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = '"user_roles"'::regclass AND conname = 'user_roles_userId_fkey'`,
      );
      expect(fkRows.length).toBe(0);

      // ADR-073 Option D — no User identity mirror was ever created in the
      // Company database; userId remains a pure external reference.
      const userMirrorRows: Array<{ count: string }> = await companyDs.query(`SELECT count(*)::text AS count FROM "users"`);
      expect(Number(userMirrorRows[0].count)).toBe(0);
    } finally {
      await companyDs.destroy();
    }

    // ADR-073 Option D — the Platform (control-plane) database's OWN
    // user_roles FK is completely untouched: the schema adjustment only
    // ever runs against a Company's own connection, never the ambient one.
    const platformFkRows: Array<{ conname: string }> = await controlPlane.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"user_roles"'::regclass AND conname = 'user_roles_userId_fkey'`,
    );
    expect(platformFkRows.length).toBe(1);

    // Proof point — the initial admin's Membership also exists in the Platform DB, carrying `company_admin` (CTO Decision 3), never the legacy `admin`.
    const membershipRows: Array<{ roleKey: string }> = await controlPlane.query(
      `SELECT "roleKey" FROM "user_company_memberships" WHERE "userId" = $1 AND "companyId" = $2`,
      [adminUserId, company.id],
    );
    expect(membershipRows).toEqual([{ roleKey: 'company_admin' }]);
  });

  it('ADR-073 negative integrity proof — an unknown Platform User is rejected BEFORE any Company-DB write, even with no local FK to catch it', async () => {
    const company = await companyRegistry.provision(INSTALLATION_ID, 'Unknown Admin Co');
    const unknownUserId = '00000000-0000-0000-0000-000000000000';

    await expect(
      service.provision({
        companyId: company.id,
        host: HOST,
        port: PORT,
        databaseName: `daii_test_${NS}area4_company_unknown_admin`,
        username: USERNAME,
        password: PASSWORD,
        appRoot: APP_ROOT,
        tags: ['core'],
        roleModuleCodes: ['sales'],
        initialAdminUserId: unknownUserId,
      }),
    ).rejects.toThrow(ProvisioningFailedError);

    // Never reached the Company-DB UserRole write for this identity — the
    // Platform-level UsersService.findById check fails first, exactly the
    // invariant ADR-073 §7 requires now that no local FK exists to catch it.
    const companyDs = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: `daii_test_${NS}area4_company_unknown_admin`, synchronize: false, logging: false });
    await companyDs.initialize();
    try {
      const rows: Array<{ count: string }> = await companyDs.query(`SELECT count(*)::text AS count FROM "user_roles" WHERE "userId" = $1`, [unknownUserId]);
      expect(Number(rows[0].count)).toBe(0);
    } finally {
      await companyDs.destroy();
    }

    // Nor did it reach Membership creation in the Platform DB.
    const membershipRows: Array<{ count: string }> = await controlPlane.query(
      `SELECT count(*)::text AS count FROM "user_company_memberships" WHERE "userId" = $1 AND "companyId" = $2`,
      [unknownUserId, company.id],
    );
    expect(Number(membershipRows[0].count)).toBe(0);
  });

  it('a provisioning failure (unreachable database) leaves a recoverable FAILED state, does not mark the Company READY (proof point 5)', async () => {
    const company = await companyRegistry.provision(INSTALLATION_ID, 'Broken Co');

    await expect(
      service.provision({
        companyId: company.id,
        host: HOST,
        port: 1, // unreachable
        databaseName: 'does-not-matter',
        username: USERNAME,
        password: PASSWORD,
        appRoot: APP_ROOT,
        tags: ['core'],
        roleModuleCodes: ['sales'],
        initialAdminUserId: adminUserId,
      }),
    ).rejects.toThrow(ProvisioningFailedError);

    const stillProvisioning = await companyRegistry.findById(company.id);
    expect(stillProvisioning?.status).toBe('PROVISIONING');
  });

  it('retrying with a corrected connection reuses the same registry row and succeeds (proof point 6)', async () => {
    const company = await companyRegistry.provision(INSTALLATION_ID, 'Retry Co');

    await expect(
      service.provision({
        companyId: company.id,
        host: HOST,
        port: 1, // unreachable, first attempt fails
        databaseName: `daii_test_${NS}area4_company_retry`,
        username: USERNAME,
        password: PASSWORD,
        appRoot: APP_ROOT,
        tags: ['core'],
        roleModuleCodes: ['sales'],
        initialAdminUserId: adminUserId,
      }),
    ).rejects.toThrow(ProvisioningFailedError);

    const retried = await service.provision({
      companyId: company.id,
      host: HOST,
      port: PORT, // corrected
      databaseName: `daii_test_${NS}area4_company_retry`,
      username: USERNAME,
      password: PASSWORD,
      appRoot: APP_ROOT,
      tags: ['core'],
      roleModuleCodes: ['sales'],
      initialAdminUserId: adminUserId,
    });

    expect(retried.readyMarked).toBe(true);
    // No duplicate registry row was created for this Company.
    const allRegistries: Array<{ count: string }> = await controlPlane.query(`SELECT count(*)::text AS count FROM "database_registries" WHERE "companyId" = $1`, [company.id]);
    expect(Number(allRegistries[0].count)).toBe(1);

    const readyCompany = await companyRegistry.findById(company.id);
    expect(readyCompany?.status).toBe('READY');
  });
});
