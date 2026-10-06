import { CompanyBaselineBackupScheduler } from './company-baseline-backup.scheduler';

/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 7, D-Backup-04).
 * Proves the sweep: (1) only backs up a Company with NO existing
 * `BackupRun` row (the "baseline" definition), (2) never touches
 * `CompanyStatus` in any way — it has no such dependency injected at all —
 * and (3) one Company's failure never stops the sweep for the rest.
 */
describe('CompanyBaselineBackupScheduler.runOnce — Track D §Step 7 (2026-09-24)', () => {
  const findOneMock = jest.fn();
  const runRepoMock = { findOne: findOneMock };
  const dataSourceMock = { getRepository: jest.fn(() => runRepoMock) };
  const connectionsMock = { listActiveCompanyIds: jest.fn() };
  const backupManagerMock = { createBackup: jest.fn() };
  let scheduler: CompanyBaselineBackupScheduler;

  beforeEach(() => {
    jest.clearAllMocks();
    scheduler = new CompanyBaselineBackupScheduler(dataSourceMock as never, connectionsMock as never, backupManagerMock as never);
  });

  it('skips a Company that already has a BackupRun — not its baseline anymore', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-1']);
    findOneMock.mockResolvedValue({ id: 'existing-run' });

    await scheduler.runOnce();

    expect(backupManagerMock.createBackup).not.toHaveBeenCalled();
  });

  it('creates a baseline backup for a Company with no existing BackupRun, trigger="baseline", initiatedByUserId=null', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-2']);
    findOneMock.mockResolvedValue(null);
    backupManagerMock.createBackup.mockResolvedValue({ id: 'run-new' });

    await scheduler.runOnce();

    expect(backupManagerMock.createBackup).toHaveBeenCalledWith('baseline', null, 'company-2');
  });

  it('one Company failing does not stop the sweep for the rest', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-a', 'company-b']);
    findOneMock.mockResolvedValue(null);
    backupManagerMock.createBackup.mockImplementation(async (_trigger: string, _user: null, companyId: string) => {
      if (companyId === 'company-a') throw new Error('registry not provisioned yet');
      return { id: 'run-b' };
    });

    await expect(scheduler.runOnce()).resolves.not.toThrow();

    expect(backupManagerMock.createBackup).toHaveBeenCalledWith('baseline', null, 'company-a');
    expect(backupManagerMock.createBackup).toHaveBeenCalledWith('baseline', null, 'company-b');
  });

  it('never depends on or references CompanyStatus — no such collaborator is injectable into this scheduler', () => {
    expect(scheduler).not.toHaveProperty('companyStatus');
    expect(CompanyBaselineBackupScheduler.length).toBe(3); // dataSource, connections, backupManager — nothing status-related
  });
});
