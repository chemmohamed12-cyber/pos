import { ClosingSnapshotRecoveryScheduler } from './closing-snapshot-recovery.scheduler';
import { ClosingSnapshotService } from './closing-snapshot.service';
import { CompanyConnectionManagerService } from '../../../foundation/database-registry/company-connection-manager.service';

describe('ClosingSnapshotRecoveryScheduler.runOnce — Multi-Company Area 9 (per-Company sweep, not ambient)', () => {
  let scheduler: ClosingSnapshotRecoveryScheduler;
  const snapshotsMock = { retryPending: jest.fn(), detectOverdue: jest.fn() };
  const connectionsMock = { listActiveCompanyIds: jest.fn(), getDataSource: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    snapshotsMock.detectOverdue.mockResolvedValue([]);
    scheduler = new ClosingSnapshotRecoveryScheduler(
      snapshotsMock as unknown as ClosingSnapshotService,
      connectionsMock as unknown as CompanyConnectionManagerService,
    );
  });

  it('sweeps every ACTIVE Company\'s own connection, never the ambient (no-arg) form', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-1', 'company-2']);
    const managerA = { tag: 'manager-a' };
    const managerB = { tag: 'manager-b' };
    connectionsMock.getDataSource.mockImplementation(async (id: string) => ({ manager: id === 'company-1' ? managerA : managerB }));

    await scheduler.runOnce();

    expect(connectionsMock.getDataSource).toHaveBeenCalledWith('company-1');
    expect(connectionsMock.getDataSource).toHaveBeenCalledWith('company-2');
    expect(snapshotsMock.retryPending).toHaveBeenCalledWith(managerA);
    expect(snapshotsMock.retryPending).toHaveBeenCalledWith(managerB);
    expect(snapshotsMock.detectOverdue).toHaveBeenCalledWith(10, managerA);
    expect(snapshotsMock.detectOverdue).toHaveBeenCalledWith(10, managerB);
  });

  it('never calls retryPending/detectOverdue with no arguments (the ambient-fallback form) when sweeping Companies', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-1']);
    connectionsMock.getDataSource.mockResolvedValue({ manager: 'm1' });

    await scheduler.runOnce();

    expect(snapshotsMock.retryPending).not.toHaveBeenCalledWith();
    expect(snapshotsMock.detectOverdue).not.toHaveBeenCalledWith();
    expect(snapshotsMock.retryPending).toHaveBeenCalledWith('m1');
  });

  it('one Company failing does not stop the sweep for the rest', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-1', 'company-2']);
    connectionsMock.getDataSource.mockResolvedValueOnce({ manager: 'm1' }).mockResolvedValueOnce({ manager: 'm2' });
    snapshotsMock.retryPending.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    await expect(scheduler.runOnce()).resolves.toBeUndefined();
    expect(snapshotsMock.retryPending).toHaveBeenCalledTimes(2);
  });

  it('a Company whose database is not ACTIVE (getDataSource throws) is skipped, not fatal to the sweep', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-1', 'company-2']);
    connectionsMock.getDataSource.mockRejectedValueOnce(new Error('not ACTIVE')).mockResolvedValueOnce({ manager: 'm2' });

    await scheduler.runOnce();

    expect(snapshotsMock.retryPending).toHaveBeenCalledTimes(1);
  });
});
