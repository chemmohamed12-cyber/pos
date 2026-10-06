import { BackupReconciliationScheduler } from './backup-reconciliation.scheduler';
import { BACKUP_MAX_ATTEMPTS } from './backup-manager.service';

/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 4/10, D-Backup-03).
 * Mirrors `MembershipReconciliationScheduler.spec.ts`'s shape. Proves the
 * sweep retries only FAILED-and-due operations against the SAME BackupRun,
 * and that one operation's failure never stops the sweep for the rest.
 */
describe('BackupReconciliationScheduler.runOnce — Track D §Step 4/10 (2026-09-24)', () => {
  const operationsMock = { findRetryable: jest.fn(), markRetrying: jest.fn(), markCompleted: jest.fn(), markFailed: jest.fn() };
  const backupManagerMock = { retryBackup: jest.fn() };
  let scheduler: BackupReconciliationScheduler;

  beforeEach(() => {
    jest.clearAllMocks();
    scheduler = new BackupReconciliationScheduler(operationsMock as never, backupManagerMock as never);
  });

  it('does nothing when there is nothing retryable', async () => {
    operationsMock.findRetryable.mockResolvedValue([]);
    await scheduler.runOnce();
    expect(backupManagerMock.retryBackup).not.toHaveBeenCalled();
  });

  it('retries the SAME backupRunId for each retryable operation, marking retrying then completed', async () => {
    operationsMock.findRetryable.mockResolvedValue([{ id: 'op-1', backupRunId: 'run-1', correlationId: 'corr-1', companyId: 'company-1' }]);
    backupManagerMock.retryBackup.mockResolvedValue({ id: 'run-1' });

    await scheduler.runOnce();

    expect(operationsMock.markRetrying).toHaveBeenCalledWith('op-1');
    expect(backupManagerMock.retryBackup).toHaveBeenCalledWith('run-1', 'corr-1');
    expect(operationsMock.markCompleted).toHaveBeenCalledWith('op-1');
    expect(operationsMock.markFailed).not.toHaveBeenCalled();
  });

  it('one operation failing does not stop the sweep for the rest, and re-marks it FAILED with the cap', async () => {
    operationsMock.findRetryable.mockResolvedValue([
      { id: 'op-1', backupRunId: 'run-1', correlationId: 'corr-1', companyId: 'company-1' },
      { id: 'op-2', backupRunId: 'run-2', correlationId: 'corr-2', companyId: null },
    ]);
    backupManagerMock.retryBackup.mockImplementation(async (backupRunId: string) => {
      if (backupRunId === 'run-1') throw new Error('pg_dump still failing');
      return { id: backupRunId };
    });

    await scheduler.runOnce();

    expect(operationsMock.markFailed).toHaveBeenCalledWith('op-1', 'pg_dump still failing', BACKUP_MAX_ATTEMPTS);
    expect(operationsMock.markCompleted).toHaveBeenCalledWith('op-2');
  });
});
