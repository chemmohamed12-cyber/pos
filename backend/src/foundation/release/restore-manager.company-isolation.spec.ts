import { ForbiddenException } from '@nestjs/common';
import { RestoreManagerService } from './restore-manager.service';

/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 8, AC-2 — the core
 * security requirement this Track exists to guarantee): "Backup Company A
 * cannot become Restore Company B." Proves `preflight()` rejects, with a
 * hard `ForbiddenException`, BEFORE any file/checksum work or database
 * touch, whenever the requested `companyId` does not exactly match the
 * chosen backup run's own `companyId` — in every direction: cross-Company,
 * Company-into-platform, and platform-into-Company.
 */
describe('RestoreManagerService.preflight — cross-Company isolation (Track D §Step 8 AC-2, 2026-09-24)', () => {
  const runRepoMock = { findOne: jest.fn() };
  const artifactRepoMock = { find: jest.fn() };
  const restoreRepoMock = { create: jest.fn(), save: jest.fn() };
  const dataSourceMock = {
    getRepository: jest.fn((entity: { name: string }) => {
      if (entity.name === 'BackupRun') return runRepoMock;
      if (entity.name === 'BackupArtifact') return artifactRepoMock;
      return restoreRepoMock;
    }),
  };
  const auditMock = { record: jest.fn() };
  const configMock = {};
  const pgDumpMock = {};
  const backupManagerMock = {};
  const databaseRegistryMock = {};

  let service: RestoreManagerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RestoreManagerService(
      dataSourceMock as never,
      configMock as never,
      pgDumpMock as never,
      backupManagerMock as never,
      auditMock as never,
      databaseRegistryMock as never,
    );
  });

  it('rejects Company A backup being restored as Company B — never reaches artifact/checksum checks', async () => {
    runRepoMock.findOne.mockResolvedValue({ id: 'run-1', companyId: 'company-A' });

    await expect(service.preflight('run-1', 'user-1', 'company-B')).rejects.toThrow(ForbiddenException);

    expect(artifactRepoMock.find).not.toHaveBeenCalled();
    expect(restoreRepoMock.create).not.toHaveBeenCalled();
    expect(restoreRepoMock.save).not.toHaveBeenCalled();
    expect(auditMock.record).not.toHaveBeenCalled();
  });

  it('rejects a Company backup being restored as a platform restore (companyId null)', async () => {
    runRepoMock.findOne.mockResolvedValue({ id: 'run-1', companyId: 'company-A' });

    await expect(service.preflight('run-1', 'user-1', null)).rejects.toThrow(ForbiddenException);
    expect(artifactRepoMock.find).not.toHaveBeenCalled();
  });

  it('rejects a platform backup being restored into a Company', async () => {
    runRepoMock.findOne.mockResolvedValue({ id: 'run-1', companyId: null });

    await expect(service.preflight('run-1', 'user-1', 'company-A')).rejects.toThrow(ForbiddenException);
    expect(artifactRepoMock.find).not.toHaveBeenCalled();
  });

  it('allows a matching Company backup to proceed to the artifact/checksum checks', async () => {
    runRepoMock.findOne.mockResolvedValue({ id: 'run-1', companyId: 'company-A', sourceAppVersion: '1.1.2', startedAt: new Date(), trigger: 'manual' });
    artifactRepoMock.find.mockResolvedValue([]);
    restoreRepoMock.create.mockImplementation((data: object) => data);
    restoreRepoMock.save.mockImplementation(async (data: { id?: string }) => ({ id: 'restore-1', ...data }));

    const result = await service.preflight('run-1', 'user-1', 'company-A');

    expect(result).toBeDefined();
    expect(restoreRepoMock.save).toHaveBeenCalled();
  });

  it('allows a matching platform backup (companyId null on both sides) to proceed', async () => {
    runRepoMock.findOne.mockResolvedValue({ id: 'run-1', companyId: null, sourceAppVersion: '1.1.2', startedAt: new Date(), trigger: 'manual' });
    artifactRepoMock.find.mockResolvedValue([]);
    restoreRepoMock.create.mockImplementation((data: object) => data);
    restoreRepoMock.save.mockImplementation(async (data: { id?: string }) => ({ id: 'restore-1', ...data }));

    const result = await service.preflight('run-1', 'user-1', null);

    expect(result).toBeDefined();
    expect(restoreRepoMock.save).toHaveBeenCalled();
  });
});
