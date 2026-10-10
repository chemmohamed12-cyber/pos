import { DataSource } from 'typeorm';
import { RestoreManagerService } from './restore-manager.service';
import { RestoreOperation } from './restore-operation.entity';
import { BackupRun } from './backup-run.entity';
import { BackupArtifact } from './backup-artifact.entity';
import { AuditRecord } from '../audit/audit-record.entity';
import { AuditService } from '../audit/audit.service';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { DatabaseCredential } from '../database-registry/database-credential.entity';
import { DatabaseCredentialCipherService } from '../database-registry/database-credential-cipher.service';
import { AppConfigService } from '../configuration/app-config.service';
import { applyCompanyAuthorizationSchemaAdjustment } from '../company/company-authorization-schema-adjustment';

/**
 * Area 14 (2026-09-25, CTO Implementation Gate §8, item 8). Real Postgres
 * proof of `RestoreManagerService.confirmAndRestore`'s new Company audit
 * chain branch — real `AuditService`/`verifyCompanyChain`, real
 * `DatabaseRegistryService`, real target Company database. `PgDumpRunnerService`
 * and `BackupManagerService` are mocked — this environment has no real
 * `pg_dump`/`pg_restore` binary (confirmed: `which pg_dump` → not found),
 * and the actual dump/restore mechanics are Track D's own, already-proven
 * concern, not what changed here. Three scenarios:
 * - zero audit rows (pre-Area-14 backup) -> restore succeeds, chain never checked
 * - rows present + valid chain -> restore succeeds
 * - rows present + broken chain -> restore rejected
 */
const NS = process.env.DAII_TEST_DB_NS ?? ''; // regression runner namespace (biz_tNN_), see two-company-real-pg-harness.ts
const HOST = process.env.DB_HOST ?? 'localhost';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 5433;
const USERNAME = process.env.DB_USER ?? 'daii';
const PASSWORD = process.env.DB_PASSWORD ?? 'daii_dev_only';
const APP_ROOT = process.cwd();

const CONTROL_PLANE_DB = `daii_test_${NS}area14_restore_control_plane`;
const COMPANY_DB = `daii_test_${NS}area14_restore_company`;

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

describe('Area 14 — RestoreManagerService audit-chain branch, real Postgres (2026-09-25)', () => {
  jest.setTimeout(300_000);

  let controlPlane: DataSource;
  let companyDs: DataSource;
  let service: RestoreManagerService;
  let audit: AuditService;
  const companyId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const backupRunId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

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

    companyDs = new DataSource({ type: 'postgres', ...companyDatabaseConfig, synchronize: false, logging: false, entities: [AuditRecord] });
    await companyDs.initialize();

    controlPlane = new DataSource({
      type: 'postgres',
      host: HOST,
      port: PORT,
      username: USERNAME,
      password: PASSWORD,
      database: CONTROL_PLANE_DB,
      synchronize: false,
      logging: false,
      entities: [RestoreOperation, BackupRun, BackupArtifact, AuditRecord, DatabaseRegistry, DatabaseCredential],
    });
    await controlPlane.initialize();
    await controlPlane.query(
      `INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ($1,$2,$3,$4,$5,$6)`,
      ['installation', 'test-installation', 'Test Installation', 'DAII_STANDARD', '1.0.0', '{}'],
    );
    await controlPlane.query(`INSERT INTO "companies" ("id","installationId","name","status") VALUES ($1,$2,$3,$4)`, [companyId, 'installation', 'Area14 Restore Co', 'READY']);

    const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as unknown as AppConfigService);
    const databaseRegistry = new DatabaseRegistryService(controlPlane.getRepository(DatabaseRegistry), controlPlane.getRepository(DatabaseCredential), cipher);
    await databaseRegistry.register({ companyId, host: HOST, port: PORT, databaseName: COMPANY_DB, status: 'ACTIVE' }, JSON.stringify({ username: USERNAME, password: PASSWORD }));

    audit = new AuditService(controlPlane);

    const pgDumpMock = { restore: jest.fn().mockResolvedValue(undefined) };
    const backupManagerMock = { createBackup: jest.fn().mockResolvedValue({ id: 'ffffffff-1111-2222-3333-444444444444' }) };
    const configMock = { releaseBackup: { storagePath: '/tmp/area14-restore-test' }, database: {} };

    service = new RestoreManagerService(controlPlane, configMock as never, pgDumpMock as never, backupManagerMock as never, audit, databaseRegistry);

    await controlPlane.getRepository(BackupRun).save(
      controlPlane.getRepository(BackupRun).create({ id: backupRunId, trigger: 'manual', companyId, status: 'completed', sourceAppVersion: '1.0.0', completedAt: new Date(), errorMessage: null }),
    );
    await controlPlane.getRepository(BackupArtifact).save(
      controlPlane
        .getRepository(BackupArtifact)
        .create({ backupRunId, type: 'database', filePath: 'db/fake.dump', sizeBytes: '1', checksumSha256: 'x', status: 'verified', verifiedAt: new Date(), errorMessage: null }),
    );
  });

  afterAll(async () => {
    if (companyDs?.isInitialized) await companyDs.destroy();
    if (controlPlane?.isInitialized) await controlPlane.destroy();
    await dropDatabase(CONTROL_PLANE_DB);
    await dropDatabase(COMPANY_DB);
  });

  async function makePendingRestoreOperation(): Promise<string> {
    const saved = await controlPlane.getRepository(RestoreOperation).save(
      controlPlane.getRepository(RestoreOperation).create({
        backupRunId,
        companyId,
        status: 'pending_confirmation',
        requestedByUserId: '11111111-2222-3333-4444-555555555555',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        preflightResult: { checks: {}, backupSummary: {} },
        confirmedByUserId: null,
        confirmedAt: null,
        safetyBackupRunId: null,
        completedAt: null,
        errorMessage: null,
      }),
    );
    return saved.id;
  }

  it('zero audit rows (pre-Area-14 backup) — restore succeeds, chain never checked', async () => {
    await companyDs.query('DELETE FROM "audit_records"');
    const opId = await makePendingRestoreOperation();

    const result = await service.confirmAndRestore(opId, '66666666-7777-8888-9999-000000000000');

    expect(result.status).toBe('completed');
  });

  it('audit rows present + valid chain — restore succeeds', async () => {
    await companyDs.query('DELETE FROM "audit_records"');
    const companyAudit = new AuditService(companyDs);
    await companyAudit.record({ actorUserId: null, organizationId: null, action: 'test.event', resource: 'x', resourceId: null, result: 'success', correlationId: null });
    const opId = await makePendingRestoreOperation();

    const result = await service.confirmAndRestore(opId, '66666666-7777-8888-9999-000000000000');

    expect(result.status).toBe('completed');
  });

  it('audit rows present + broken chain — restore rejected', async () => {
    await companyDs.query('DELETE FROM "audit_records"');
    const companyAudit = new AuditService(companyDs);
    await companyAudit.record({ actorUserId: null, organizationId: null, action: 'test.event', resource: 'x', resourceId: null, result: 'success', correlationId: null });
    await companyDs.query(`UPDATE "audit_records" SET "hash" = 'corrupted'`);
    const opId = await makePendingRestoreOperation();

    await expect(service.confirmAndRestore(opId, '66666666-7777-8888-9999-000000000000')).rejects.toThrow(/audit chain is broken/i);

    const failed = await controlPlane.getRepository(RestoreOperation).findOneOrFail({ where: { id: opId } });
    expect(failed.status).toBe('failed');
  });
});
