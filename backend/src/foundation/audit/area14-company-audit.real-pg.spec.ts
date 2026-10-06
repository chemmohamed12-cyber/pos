import { DataSource } from 'typeorm';
import { AuditRecord } from './audit-record.entity';
import { AuditService } from './audit.service';
import { CompanyMembershipProvisioningService } from '../company/company-membership-provisioning.service';
import { MembershipService } from '../company/membership.service';
import { Membership } from '../company/membership.entity';
import { MembershipOperationService } from '../company/membership-operation.service';
import { MembershipOperation } from '../company/membership-operation.entity';
import { UsersService } from '../identity/users.service';
import { User } from '../identity/user.entity';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { DatabaseCredential } from '../database-registry/database-credential.entity';
import { DatabaseCredentialCipherService } from '../database-registry/database-credential-cipher.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { AppConfigService } from '../configuration/app-config.service';
import { applyCompanyAuthorizationSchemaAdjustment } from '../company/company-authorization-schema-adjustment';
import { seedCompanyRoleTemplates, seedCompanyAdminRole } from '../company/company-role-seeding';

/**
 * Area 14 (2026-09-25, CTO Implementation Gate §8, items 1-4). Real
 * Postgres, two separately-provisioned Companies, proving:
 * 1. A Company-scoped audit write lands in the correct Company DB.
 * 2. The Platform DB gets its own, separate, non-duplicate record (same
 *    correlationId, different boundary — §S2/Decision §4).
 * 3. It does NOT land in a different Company's DB.
 * 4. `AuditService.verifyCompanyChain()` correctly reports both a valid
 *    chain and a deliberately corrupted one.
 */
const HOST = process.env.DB_HOST ?? 'localhost';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 5433;
const USERNAME = process.env.DB_USER ?? 'daii';
const PASSWORD = process.env.DB_PASSWORD ?? 'daii_dev_only';
const APP_ROOT = process.cwd();

const CONTROL_PLANE_DB = 'daii_test_area14_control_plane';
const COMPANY_A_DB = 'daii_test_area14_company_a';
const COMPANY_B_DB = 'daii_test_area14_company_b';

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

describe('Area 14 — Company-scoped audit trail, real Postgres isolation + chain proof (2026-09-25)', () => {
  jest.setTimeout(300_000);

  let controlPlane: DataSource;
  let connections: CompanyConnectionManagerService;
  let audit: AuditService;
  let provisioning: CompanyMembershipProvisioningService;
  const companyAId = '88888888-8888-8888-8888-888888888888';
  const companyBId = '99999999-9999-9999-9999-999999999999';

  async function provisionCompany(dbName: string, companyId: string): Promise<void> {
    const config = { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: dbName };
    const { runMigrationsForDatabase } = await import('../release-orchestration/company-migration-runner');
    const migrated = await runMigrationsForDatabase(APP_ROOT, config, ['core']);
    if (!migrated.success) throw new Error(`migration failed for ${dbName}: ${migrated.error}`);
    await applyCompanyAuthorizationSchemaAdjustment(config);
    await seedCompanyRoleTemplates(config, ['sales']);
    await seedCompanyAdminRole(config, ['sales']);

    await controlPlane.query(`INSERT INTO "companies" ("id","installationId","name","status") VALUES ($1,$2,$3,$4)`, [companyId, 'installation', `Area14 ${dbName}`, 'READY']);
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
      entities: [Membership, MembershipOperation, User, AuditRecord, DatabaseRegistry, DatabaseCredential],
    });
    await controlPlane.initialize();
    await controlPlane.query(
      `INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ($1,$2,$3,$4,$5,$6)`,
      ['installation', 'test-installation', 'Test Installation', 'DAII_STANDARD', '1.0.0', '{}'],
    );

    await provisionCompany(COMPANY_A_DB, companyAId);
    await provisionCompany(COMPANY_B_DB, companyBId);

    const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as unknown as AppConfigService);
    const databaseRegistry = new DatabaseRegistryService(controlPlane.getRepository(DatabaseRegistry), controlPlane.getRepository(DatabaseCredential), cipher);
    connections = new CompanyConnectionManagerService(databaseRegistry);
    audit = new AuditService(controlPlane);
    const memberships = new MembershipService(controlPlane.getRepository(Membership));
    const operations = new MembershipOperationService(controlPlane.getRepository(MembershipOperation));
    const users = new UsersService(controlPlane.getRepository(User));
    provisioning = new CompanyMembershipProvisioningService(memberships, connections, operations, users, audit);
  });

  afterAll(async () => {
    if (connections) await connections.onModuleDestroy();
    if (controlPlane?.isInitialized) await controlPlane.destroy();
    await dropDatabase(CONTROL_PLANE_DB);
    await dropDatabase(COMPANY_A_DB);
    await dropDatabase(COMPANY_B_DB);
  });

  it('items 1-3: a Company A grant lands in Company A audit, in Platform audit, and NOT in Company B audit', async () => {
    const admin = await users_create(controlPlane, 'Area14 User A');
    const membership = await provisioning.grantMembership(null, admin.id, companyAId, 'sales.manager');
    void membership;

    const dsA = await connections.getDataSource(companyAId);
    const dsB = await connections.getDataSource(companyBId);

    // 1. Company A's own audit_records has the Company-side record.
    const companyARows = await dsA.getRepository(AuditRecord).find({ where: { action: 'company.membership.granted', resource: 'user_role' } });
    expect(companyARows.length).toBe(1);
    expect(companyARows[0].resourceId).toBe(admin.id);

    // 2. Platform's own audit_records has its OWN separate record, same correlationId, different boundary.
    const platformRows = await controlPlane.getRepository(AuditRecord).find({ where: { action: 'company.membership.granted', resource: 'membership' } });
    expect(platformRows.length).toBeGreaterThanOrEqual(1);
    const linked = platformRows.find((r) => r.correlationId === companyARows[0].correlationId);
    expect(linked).toBeDefined(); // same correlationId links the two boundary-specific records — not a duplicate

    // 3. Company B's audit_records has NOTHING from this operation.
    const companyBRows = await dsB.getRepository(AuditRecord).find({ where: { action: 'company.membership.granted', resource: 'user_role' } });
    expect(companyBRows.length).toBe(0);
  });

  it('item 4: verifyCompanyChain() reports a valid chain for Company A, and correctly detects a deliberately corrupted one', async () => {
    const dsA = await connections.getDataSource(companyAId);
    const valid = await audit.verifyCompanyChain(dsA.manager);
    expect(valid.valid).toBe(true);
    expect(valid.brokenAtSeq).toBeNull();

    // Corrupt the one row's hash directly — proves detection, not just happy-path.
    await dsA.query(`UPDATE "audit_records" SET "hash" = 'deliberately-corrupted' WHERE "seq" = (SELECT MIN("seq") FROM "audit_records")`);
    const broken = await audit.verifyCompanyChain(dsA.manager);
    expect(broken.valid).toBe(false);
    expect(broken.brokenAtSeq).not.toBeNull();
  });

  it('Company B has its own, fully independent chain — corrupting Company A never affects it', async () => {
    const admin = await users_create(controlPlane, 'Area14 User B');
    await provisioning.grantMembership(null, admin.id, companyBId, 'sales.manager');

    const dsB = await connections.getDataSource(companyBId);
    const chainB = await audit.verifyCompanyChain(dsB.manager);
    expect(chainB.valid).toBe(true); // Company A's corruption (previous test) never touched Company B's own chain
  });
});

async function users_create(controlPlane: DataSource, fullName: string) {
  const users = new UsersService(controlPlane.getRepository(User));
  return users.create({ fullName, email: `${fullName.toLowerCase().replace(/\s+/g, '-')}@test.local` });
}
