import { ApprovalExpiryScheduler } from './approval-expiry.scheduler';
import { ApprovalEngineService } from './approval-engine.service';
import { ConfigurationEngineService } from '../configuration-engine/configuration-engine.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { DataSource } from 'typeorm';

describe('ApprovalExpiryScheduler.runOnce — Multi-Company Area 9 (per-Company sweep, not ambient)', () => {
  let scheduler: ApprovalExpiryScheduler;
  const engineMock = { expire: jest.fn() };
  const configMock = { get: jest.fn() };
  const connectionsMock = { listActiveCompanyIds: jest.fn(), getDataSource: jest.fn() };
  const platformStatus: Record<string, string> = {};
  const platformMock = {
    createQueryRunner: () => ({
      isTransactionActive: true,
      connect: async () => undefined,
      startTransaction: async () => undefined,
      query: async (_sql: string, params: [string]) => [{ status: platformStatus[params[0]] ?? 'READY' }],
      commitTransaction: async () => undefined,
      rollbackTransaction: async () => undefined,
      release: async () => undefined,
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of Object.keys(platformStatus)) delete platformStatus[k];
    configMock.get.mockReturnValue(true); // expire_sweep_enabled
    scheduler = new ApprovalExpiryScheduler(
      engineMock as unknown as ApprovalEngineService,
      configMock as unknown as ConfigurationEngineService,
      connectionsMock as unknown as CompanyConnectionManagerService,
      platformMock as unknown as DataSource,
    );
  });

  it('does nothing when the sweep is disabled — never even lists Companies', async () => {
    configMock.get.mockReturnValue(false);
    await scheduler.runOnce();
    expect(connectionsMock.listActiveCompanyIds).not.toHaveBeenCalled();
  });

  it('calls engine.expire(dataSource) once per ACTIVE Company, never the ambient (no-arg) form', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-1', 'company-2']);
    const dsA = { name: 'ds-a' };
    const dsB = { name: 'ds-b' };
    connectionsMock.getDataSource.mockImplementation(async (id: string) => (id === 'company-1' ? dsA : dsB));
    engineMock.expire.mockResolvedValue({ expired: 0 });

    await scheduler.runOnce();

    expect(connectionsMock.getDataSource).toHaveBeenCalledWith('company-1');
    expect(connectionsMock.getDataSource).toHaveBeenCalledWith('company-2');
    expect(engineMock.expire).toHaveBeenNthCalledWith(1, dsA);
    expect(engineMock.expire).toHaveBeenNthCalledWith(2, dsB);
  });

  it('one Company failing does not stop the sweep for the rest', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-1', 'company-2']);
    connectionsMock.getDataSource.mockResolvedValueOnce({ name: 'ds-a' }).mockResolvedValueOnce({ name: 'ds-b' });
    engineMock.expire.mockRejectedValueOnce(new Error('company-1 database unreachable')).mockResolvedValueOnce({ expired: 1 });

    await expect(scheduler.runOnce()).resolves.toBeUndefined();
    expect(engineMock.expire).toHaveBeenCalledTimes(2);
  });

  it('a Company whose database is not ACTIVE (getDataSource throws) is skipped, not fatal to the sweep', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-1', 'company-2']);
    connectionsMock.getDataSource.mockRejectedValueOnce(new Error('not ACTIVE')).mockResolvedValueOnce({ name: 'ds-b' });
    engineMock.expire.mockResolvedValue({ expired: 0 });

    await scheduler.runOnce();

    expect(engineMock.expire).toHaveBeenCalledTimes(1);
  });

  it('LA-1 Layer 2: a Company that is not READY at execution time is skipped — expire() is never called for it and its DataSource is never requested — while the other Company still runs', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-1', 'company-2']);
    platformStatus['company-1'] = 'DECOMMISSIONED';
    const dsB = { name: 'ds-b' };
    connectionsMock.getDataSource.mockImplementation(async (id: string) => (id === 'company-2' ? dsB : { name: 'must-not-be-used' }));
    engineMock.expire.mockResolvedValue({ expired: 0 });

    await scheduler.runOnce();

    expect(connectionsMock.getDataSource).not.toHaveBeenCalledWith('company-1');
    expect(engineMock.expire).toHaveBeenCalledTimes(1);
    expect(engineMock.expire).toHaveBeenCalledWith(dsB);
  });
});
