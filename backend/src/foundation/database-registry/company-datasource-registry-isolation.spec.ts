import { DataSource } from 'typeorm';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { AuthorizationService } from '../authorization/authorization.service';
import { DatabaseRegistryService } from './database-registry.service';
import { DatabaseRegistry } from './database-registry.entity';
import { DatabaseCredential } from './database-credential.entity';
import { DatabaseCredentialCipherService } from './database-credential-cipher.service';
import { CompanyConnectionManagerService } from './company-connection-manager.service';
import { AppConfigService } from '../configuration/app-config.service';
import { applyCompanyAuthorizationSchemaAdjustment } from '../company/company-authorization-schema-adjustment';
import { seedCompanyRoleTemplates, seedCompanyAdminRole } from '../company/company-role-seeding';

/**
 * ADR-074 Gate D (CTO Decision, Hybrid B approval, 2026-09-25). Proves the
 * `COMPANY_ENTITY_REGISTRY` fix did NOT change `CompanyConnectionManagerService`'s
 * isolation semantics — the one thing the CTO's approval explicitly forbade
 * touching. Two real, separately-provisioned Company databases, each with
 * its own distinct grant:
 *
 *   Company A request -> Company A DataSource -> Company A entity metadata -> authorization
 *   Company B must never be selected/touched by a Company A request.
 */
const NS = process.env.DAII_TEST_DB_NS ?? ''; // regression runner namespace (biz_tNN_), see two-company-real-pg-harness.ts
const HOST = process.env.DB_HOST ?? 'localhost';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 5433;
const USERNAME = process.env.DB_USER ?? 'daii';
const PASSWORD = process.env.DB_PASSWORD ?? 'daii_dev_only';
const APP_ROOT = process.cwd();

const CONTROL_PLANE_DB = `daii_test_${NS}adr074_gated_control_plane`;
const COMPANY_A_DB = `daii_test_${NS}adr074_gated_company_a`;
const COMPANY_B_DB = `daii_test_${NS}adr074_gated_company_b`;

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

describe('ADR-074 Gate D — Area 21 cross-company isolation, unaffected by COMPANY_ENTITY_REGISTRY (2026-09-25)', () => {
  jest.setTimeout(300_000);

  let controlPlane: DataSource;
  let connections: CompanyConnectionManagerService;
  const companyAId = '44444444-4444-4444-4444-444444444444';
  const companyBId = '55555555-5555-5555-5555-555555555555';
  const userOnlyInA = '66666666-6666-6666-6666-666666666666';
  const userOnlyInB = '77777777-7777-7777-7777-777777777777';

  async function provisionCompany(dbName: string, companyId: string, userId: string): Promise<void> {
    const config = { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: dbName };
    const { runMigrationsForDatabase } = await import('../release-orchestration/company-migration-runner');
    const migrated = await runMigrationsForDatabase(APP_ROOT, config, ['core']);
    if (!migrated.success) throw new Error(`migration failed for ${dbName}: ${migrated.error}`);
    await applyCompanyAuthorizationSchemaAdjustment(config);
    await seedCompanyRoleTemplates(config, ['sales']);
    await seedCompanyAdminRole(config, ['sales']);

    const setupDs = new DataSource({ type: 'postgres', ...config, synchronize: false, logging: false, entities: [Role, UserRole] });
    await setupDs.initialize();
    try {
      const role = await setupDs.getRepository(Role).findOneOrFail({ where: { key: 'admin' } });
      await setupDs.getRepository(UserRole).save(setupDs.getRepository(UserRole).create({ userId, roleId: role.id }));
    } finally {
      await setupDs.destroy();
    }

    await controlPlane.query(`INSERT INTO "companies" ("id","installationId","name","status") VALUES ($1,$2,$3,$4)`, [companyId, 'installation', `Gate D ${dbName}`, 'READY']);
    const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as unknown as AppConfigService);
    const databaseRegistry = new DatabaseRegistryService(controlPlane.getRepository(DatabaseRegistry), controlPlane.getRepository(DatabaseCredential), cipher);
    await databaseRegistry.register({ companyId, host: HOST, port: PORT, databaseName: dbName, status: 'ACTIVE' }, JSON.stringify({ username: USERNAME, password: PASSWORD }));
  }

  beforeAll(async () => {
    await createDatabase(CONTROL_PLANE_DB);
    await createDatabase(COMPANY_A_DB);
    await createDatabase(COMPANY_B_DB);

    const { runMigrationsForDatabase } = await import('../release-orchestration/company-migration-runner');
    const migratedControlPlane = await runMigrationsForDatabase(APP_ROOT, { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: CONTROL_PLANE_DB }, ['core']);
    if (!migratedControlPlane.success) throw new Error(`control-plane migration failed: ${migratedControlPlane.error}`);

    controlPlane = new DataSource({
      type: 'postgres',
      host: HOST,
      port: PORT,
      username: USERNAME,
      password: PASSWORD,
      database: CONTROL_PLANE_DB,
      synchronize: false,
      logging: false,
      entities: [DatabaseRegistry, DatabaseCredential],
    });
    await controlPlane.initialize();
    await controlPlane.query(
      `INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ($1,$2,$3,$4,$5,$6)`,
      ['installation', 'test-installation', 'Test Installation', 'DAII_STANDARD', '1.0.0', '{}'],
    );

    await provisionCompany(COMPANY_A_DB, companyAId, userOnlyInA);
    await provisionCompany(COMPANY_B_DB, companyBId, userOnlyInB);

    const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as unknown as AppConfigService);
    const databaseRegistry = new DatabaseRegistryService(controlPlane.getRepository(DatabaseRegistry), controlPlane.getRepository(DatabaseCredential), cipher);
    connections = new CompanyConnectionManagerService(databaseRegistry);
  });

  afterAll(async () => {
    if (connections) await connections.onModuleDestroy();
    if (controlPlane?.isInitialized) await controlPlane.destroy();
    await dropDatabase(CONTROL_PLANE_DB);
    await dropDatabase(COMPANY_A_DB);
    await dropDatabase(COMPANY_B_DB);
  });

  it('Company A connection resolves Company A grant, and does NOT see Company B\'s user at all', async () => {
    const dsA = await connections.getDataSource(companyAId);
    const roleRepoA = controlPlane.manager; // ambient repo unused, manager always supplied below
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    void roleRepoA;

    const rolesForUserInA = await authorization.getRoleKeysForUser(userOnlyInA, dsA.manager);
    expect(rolesForUserInA).toContain('admin');

    const rolesForUserOnlyInB_viaCompanyA = await authorization.getRoleKeysForUser(userOnlyInB, dsA.manager);
    expect(rolesForUserOnlyInB_viaCompanyA).toEqual([]); // Company B's user is invisible through Company A's connection
  });

  it('Company B connection resolves Company B grant, and does NOT see Company A\'s user at all', async () => {
    const dsB = await connections.getDataSource(companyBId);
    const authorization = new AuthorizationService(dsB.getRepository(Role), dsB.getRepository(UserRole));

    const rolesForUserInB = await authorization.getRoleKeysForUser(userOnlyInB, dsB.manager);
    expect(rolesForUserInB).toContain('admin');

    const rolesForUserOnlyInA_viaCompanyB = await authorization.getRoleKeysForUser(userOnlyInA, dsB.manager);
    expect(rolesForUserOnlyInA_viaCompanyB).toEqual([]);
  });

  it('CompanyConnectionManagerService returns genuinely distinct, separately-cached DataSource objects for A and B', async () => {
    const dsA = await connections.getDataSource(companyAId);
    const dsB = await connections.getDataSource(companyBId);
    expect(dsA).not.toBe(dsB);
    expect(dsA.options.database).toBe(COMPANY_A_DB);
    expect(dsB.options.database).toBe(COMPANY_B_DB);

    // Re-requesting the same Company returns the SAME cached instance (unchanged cache contract).
    const dsAAgain = await connections.getDataSource(companyAId);
    expect(dsAAgain).toBe(dsA);
  });
});
