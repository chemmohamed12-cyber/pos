import { IsNull } from 'typeorm';
import { BackupManagerService } from './backup-manager.service';
import { BackupRun } from './backup-run.entity';
import { BackupArtifact } from './backup-artifact.entity';
import { CompanyBackupSettings } from './company-backup-settings.entity';

jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn().mockResolvedValue({ size: 1234 }),
  rm: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./checksum', () => ({ computeFileChecksum: jest.fn().mockResolvedValue('fixed-checksum') }));

import { mkdir } from 'fs/promises';

/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 5/6 — the
 * poisoned-ambient-connection technique established for Area 9). Proves a
 * Company-scoped backup NEVER falls back to the platform/ambient database
 * config — `this.config.database` throws if touched — and that retention
 * (AC-3) is evaluated strictly per-Company, never the platform's `IsNull()`
 * default.
 */
describe('BackupManagerService — Company-scoped path (Track D §Step 5/6, 2026-09-24)', () => {
  const runRepoMock = { create: jest.fn(), save: jest.fn() };
  const artifactRepoMock = { create: jest.fn(), save: jest.fn(), find: jest.fn().mockResolvedValue([]), remove: jest.fn() };
  const settingsRepoMock = { findOne: jest.fn().mockResolvedValue(null) };
  const dataSourceMock = {
    getRepository: jest.fn((entity: { name: string }) => {
      if (entity === BackupRun) return runRepoMock;
      if (entity === BackupArtifact) return artifactRepoMock;
      if (entity === CompanyBackupSettings) return settingsRepoMock;
      throw new Error(`unexpected getRepository(${entity?.name})`);
    }),
    query: jest.fn(),
  };
  // Poisoned ambient config — a Company-scoped call must NEVER touch this.
  const configMock = {
    get database(): never {
      throw new Error('POISONED: ambient/platform database config was touched during a Company-scoped backup.');
    },
    releaseBackup: { storagePath: '/tmp/backups', retentionDays: 30 },
  };
  const pgDumpMock = { dump: jest.fn().mockResolvedValue(undefined), verifyDumpStructure: jest.fn().mockResolvedValue({ ok: true }) };
  const auditMock = { record: jest.fn() };
  const companyDatabaseConfig = { host: 'company-host', port: 5432, username: 'u', password: 'p', database: 'company_db' };
  const databaseRegistryMock = { getConnectionConfigForCompany: jest.fn().mockResolvedValue(companyDatabaseConfig) };
  const backupOperationsMock = {
    start: jest.fn().mockResolvedValue({ id: 'op-1', correlationId: 'corr-1' }),
    markRunning: jest.fn().mockResolvedValue(undefined),
    markCompleted: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  const companiesMock = { findById: jest.fn().mockResolvedValue({ id: 'company-1', installationId: 'install-1' }) };

  let service: BackupManagerService;

  beforeEach(() => {
    jest.clearAllMocks();
    settingsRepoMock.findOne.mockResolvedValue(null);
    pgDumpMock.dump.mockResolvedValue(undefined);
    pgDumpMock.verifyDumpStructure.mockResolvedValue({ ok: true });
    databaseRegistryMock.getConnectionConfigForCompany.mockResolvedValue(companyDatabaseConfig);
    backupOperationsMock.start.mockResolvedValue({ id: 'op-1', correlationId: 'corr-1' });
    runRepoMock.create.mockImplementation((data: object) => data);
    runRepoMock.save.mockImplementation(async (data: { id?: string }) => ({ id: data.id ?? 'run-1', startedAt: new Date(), ...data }));
    artifactRepoMock.create.mockImplementation((data: object) => data);
    artifactRepoMock.save.mockImplementation(async (data: { id?: string }) => ({ id: 'artifact-1', ...data }));
    service = new BackupManagerService(
      dataSourceMock as never,
      configMock as never,
      pgDumpMock as never,
      auditMock as never,
      databaseRegistryMock as never,
      backupOperationsMock as never,
      companiesMock as never,
    );
  });

  it('resolves the Company database via DatabaseRegistryService, never the ambient config', async () => {
    const run = await service.createBackup('manual', 'user-1', 'company-1');

    expect(databaseRegistryMock.getConnectionConfigForCompany).toHaveBeenCalledWith('company-1');
    expect(pgDumpMock.dump).toHaveBeenCalledWith(companyDatabaseConfig, expect.any(String));
    expect(run.companyId).toBe('company-1');
  });

  it('skips the media artifact entirely for a Company backup — no media directory is created', async () => {
    await service.createBackup('manual', 'user-1', 'company-1');

    const mkdirCalls = (mkdir as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(mkdirCalls.some((p) => p.includes('media'))).toBe(false);
    expect(mkdirCalls.some((p) => p.includes('db'))).toBe(true);
  });

  it('drives the attempt through the BackupOperation ledger (start/markRunning/markCompleted)', async () => {
    await service.createBackup('manual', 'user-1', 'company-1');

    expect(backupOperationsMock.start).toHaveBeenCalledWith('company-1', expect.any(String));
    expect(backupOperationsMock.markRunning).toHaveBeenCalledWith('op-1');
    expect(backupOperationsMock.markCompleted).toHaveBeenCalledWith('op-1');
  });

  it('never touches organizationId with the companyId — records companyId only in the audit "after" payload', async () => {
    await service.createBackup('manual', 'user-1', 'company-1');

    for (const call of auditMock.record.mock.calls) {
      const [record] = call as [{ organizationId: unknown; after?: Record<string, unknown> }];
      expect(record.organizationId).toBeNull();
    }
  });

  it('a platform backup (companyId omitted) still uses the ambient config unaffected — the poisoned mock only throws for Company calls', async () => {
    const platformConfig = { host: 'platform-host', port: 5432, username: 'u', password: 'p', database: 'platform_db' };
    const configWithPlatformDb = { database: platformConfig, releaseBackup: configMock.releaseBackup, mediaStoragePath: '/tmp/nonexistent-media' };
    const platformService = new BackupManagerService(
      dataSourceMock as never,
      configWithPlatformDb as never,
      pgDumpMock as never,
      auditMock as never,
      databaseRegistryMock as never,
      backupOperationsMock as never,
      companiesMock as never,
    );

    const run = await platformService.createBackup('manual', 'user-1');

    expect(run.companyId).toBeNull();
    expect(databaseRegistryMock.getConnectionConfigForCompany).not.toHaveBeenCalled();
    expect(pgDumpMock.dump).toHaveBeenCalledWith(platformConfig, expect.any(String));
  });

  it('applyRetentionPolicy(companyId) — AC-3 — queries strictly by that Company, never platform IsNull()', async () => {
    const findSpy = jest.fn().mockResolvedValue([]);
    dataSourceMock.getRepository = jest.fn((entity: { name: string }) => {
      if (entity === BackupRun) return { find: findSpy };
      if (entity === CompanyBackupSettings) return settingsRepoMock;
      if (entity === BackupArtifact) return artifactRepoMock;
      throw new Error('unexpected');
    }) as never;
    service = new BackupManagerService(
      dataSourceMock as never,
      configMock as never,
      pgDumpMock as never,
      auditMock as never,
      databaseRegistryMock as never,
      backupOperationsMock as never,
      companiesMock as never,
    );

    await service.applyRetentionPolicy('company-1');

    expect(findSpy).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 'company-1' } }));
  });

  it('applyRetentionPolicy() with no companyId — unchanged platform behavior — queries with IsNull()', async () => {
    const findSpy = jest.fn().mockResolvedValue([]);
    dataSourceMock.getRepository = jest.fn((entity: { name: string }) => {
      if (entity === BackupRun) return { find: findSpy };
      if (entity === CompanyBackupSettings) return settingsRepoMock;
      if (entity === BackupArtifact) return artifactRepoMock;
      throw new Error('unexpected');
    }) as never;
    const platformConfig = { host: 'platform-host', port: 5432, username: 'u', password: 'p', database: 'platform_db' };
    const configWithPlatformDb = { database: platformConfig, releaseBackup: configMock.releaseBackup };
    service = new BackupManagerService(
      dataSourceMock as never,
      configWithPlatformDb as never,
      pgDumpMock as never,
      auditMock as never,
      databaseRegistryMock as never,
      backupOperationsMock as never,
      companiesMock as never,
    );

    await service.applyRetentionPolicy();

    const calledWhere = findSpy.mock.calls[0][0].where;
    expect(calledWhere.companyId).toEqual(IsNull());
  });
});
