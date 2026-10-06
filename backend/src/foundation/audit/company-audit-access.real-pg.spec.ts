import { DataSource } from 'typeorm';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { RolePermission } from '../permission/role-permission.entity';
import { AuditRecord } from './audit-record.entity';
import { AuditService } from './audit.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { PermissionService } from '../permission/permission.service';
import { CompanyAuditController } from './company-audit.controller';
import { InstallationAuditController } from './installation-audit.controller';
import { COMPANY_AUDIT_VIEW_NODE } from '../company/company-role-seeding';
import { CompanyScopedRequest } from '../company/company-context.guard';
import { AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { DatabaseCredential } from '../database-registry/database-credential.entity';
import { DatabaseCredentialCipherService } from '../database-registry/database-credential-cipher.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { AppConfigService } from '../configuration/app-config.service';
import { applyCompanyAuthorizationSchemaAdjustment } from '../company/company-authorization-schema-adjustment';
import { seedCompanyRoleTemplates, seedCompanyAdminRole } from '../company/company-role-seeding';

/**
 * Area 14 (2026-09-25, CTO Implementation Gate §8, items 5-7). Real
 * Postgres proof that:
 * 5. The Company Audit permission boundary (`COMPANY_AUDIT_VIEW_NODE`)
 *    actually gates access — an admin-role user is allowed, a user with
 *    no grant for this node is not.
 * 6. `InstallationAuditController` reaches the named Company via its own
 *    route param, independent of the self-service path.
 * 7. Each successful query records exactly one `company.audit.accessed`
 *    event — never zero, never more than one.
 */
const HOST = process.env.DB_HOST ?? 'localhost';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 5433;
const USERNAME = process.env.DB_USER ?? 'daii';
const PASSWORD = process.env.DB_PASSWORD ?? 'daii_dev_only';
const APP_ROOT = process.cwd();

const CONTROL_PLANE_DB = 'daii_test_area14_access_control_plane';
const COMPANY_DB = 'daii_test_area14_access_company';

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

describe('Area 14 — CompanyAuditController / InstallationAuditController, real Postgres (2026-09-25)', () => {
  jest.setTimeout(300_000);

  let controlPlane: DataSource;
  let connections: CompanyConnectionManagerService;
  let audit: AuditService;
  const companyId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const adminUserId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const noGrantUserId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  beforeAll(async () => {
    await createDatabase(CONTROL_PLANE_DB);
    await createDatabase(COMPANY_DB);

    const { runMigrationsForDatabase } = await import('../release-orchestration/company-migration-runner');
    const migratedControlPlane = await runMigrationsForDatabase(APP_ROOT, { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: CONTROL_PLANE_DB }, ['core']);
    if (!migratedControlPlane.success) throw new Error(`control-plane migration failed: ${migratedControlPlane.error}`);

    const companyDatabaseConfig = { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: COMPANY_DB };
    const migratedCompany = await runMigrationsForDatabase(APP_ROOT, companyDatabaseConfig, ['core']);
    if (!migratedCompany.success) throw new Error(`company migration failed: ${migratedCompany.error}`);
    await applyCompanyAuthorizationSchemaAdjustment(companyDatabaseConfig);
    await seedCompanyRoleTemplates(companyDatabaseConfig, ['sales']);
    await seedCompanyAdminRole(companyDatabaseConfig, ['sales']);

    // adminUserId gets the seeded 'admin' role (has COMPANY_AUDIT_VIEW_NODE); noGrantUserId gets a
    // narrow role with NO grant for that node at all — the actual permission-boundary contrast.
    const setupDs = new DataSource({ type: 'postgres', ...companyDatabaseConfig, synchronize: false, logging: false, entities: [Role, UserRole] });
    await setupDs.initialize();
    try {
      const adminRole = await setupDs.getRepository(Role).findOneOrFail({ where: { key: 'admin' } });
      await setupDs.getRepository(UserRole).save(setupDs.getRepository(UserRole).create({ userId: adminUserId, roleId: adminRole.id }));
      const repRole = await setupDs.getRepository(Role).findOneOrFail({ where: { key: 'sales.rep' } });
      await setupDs.getRepository(UserRole).save(setupDs.getRepository(UserRole).create({ userId: noGrantUserId, roleId: repRole.id }));
    } finally {
      await setupDs.destroy();
    }

    controlPlane = new DataSource({
      type: 'postgres',
      host: HOST,
      port: PORT,
      username: USERNAME,
      password: PASSWORD,
      database: CONTROL_PLANE_DB,
      synchronize: false,
      logging: false,
      entities: [DatabaseRegistry, DatabaseCredential, Role, UserRole, RolePermission],
    });
    await controlPlane.initialize();
    await controlPlane.query(
      `INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ($1,$2,$3,$4,$5,$6)`,
      ['installation', 'test-installation', 'Test Installation', 'DAII_STANDARD', '1.0.0', '{}'],
    );
    await controlPlane.query(`INSERT INTO "companies" ("id","installationId","name","status") VALUES ($1,$2,$3,$4)`, [companyId, 'installation', 'Area14 Access Co', 'READY']);

    const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as unknown as AppConfigService);
    const databaseRegistry = new DatabaseRegistryService(controlPlane.getRepository(DatabaseRegistry), controlPlane.getRepository(DatabaseCredential), cipher);
    await databaseRegistry.register({ companyId, host: HOST, port: PORT, databaseName: COMPANY_DB, status: 'ACTIVE' }, JSON.stringify({ username: USERNAME, password: PASSWORD }));

    connections = new CompanyConnectionManagerService(databaseRegistry);
    audit = new AuditService(controlPlane);
  });

  afterAll(async () => {
    if (connections) await connections.onModuleDestroy();
    if (controlPlane?.isInitialized) await controlPlane.destroy();
    await dropDatabase(CONTROL_PLANE_DB);
    await dropDatabase(COMPANY_DB);
  });

  it('item 5: the admin-role user IS granted COMPANY_AUDIT_VIEW_NODE; the no-grant user is NOT', async () => {
    const dataSource = await connections.getDataSource(companyId);
    const authorization = new AuthorizationService(controlPlane.getRepository(Role), controlPlane.getRepository(UserRole));
    const permission = new PermissionService(controlPlane.getRepository(RolePermission), authorization);

    const adminAllowed = await permission.hasAtLeast(adminUserId, COMPANY_AUDIT_VIEW_NODE, 'read-only', dataSource.manager);
    expect(adminAllowed).toBe(true);

    const noGrantAllowed = await permission.hasAtLeast(noGrantUserId, COMPANY_AUDIT_VIEW_NODE, 'read-only', dataSource.manager);
    expect(noGrantAllowed).toBe(false);
  });

  it('items 6-7: CompanyAuditController scopes to req.companyContext only, and records exactly one access event per query', async () => {
    const dataSource = await connections.getDataSource(companyId);
    const controller = new CompanyAuditController(audit);
    const req = { user: { id: adminUserId }, companyContext: { companyId, dataSource } } as unknown as CompanyScopedRequest;

    const before = await dataSource.getRepository(AuditRecord).find({ where: { action: 'company.audit.accessed' } });
    const result = await controller.list(req);
    const after = await dataSource.getRepository(AuditRecord).find({ where: { action: 'company.audit.accessed' } });

    expect(result.success).toBe(true);
    expect(after.length).toBe(before.length + 1); // exactly one access event, not zero, not more
  });

  it('item 6: InstallationAuditController reaches the named Company via its own route param, independent of self-service', async () => {
    const controller = new InstallationAuditController(connections, audit);
    const req = { user: { id: adminUserId } } as unknown as AuthenticatedRequest;

    const dataSource = await connections.getDataSource(companyId);
    const before = await dataSource.getRepository(AuditRecord).find({ where: { action: 'company.audit.accessed' } });
    const result = await controller.list(req, companyId);
    const after = await dataSource.getRepository(AuditRecord).find({ where: { action: 'company.audit.accessed' } });

    expect(result.success).toBe(true);
    expect(after.length).toBe(before.length + 1);
    const lastEvent = after[after.length - 1];
    expect((lastEvent.after as { accessedByInstallationAdmin?: boolean } | null)?.accessedByInstallationAdmin).toBe(true);
  });
});
