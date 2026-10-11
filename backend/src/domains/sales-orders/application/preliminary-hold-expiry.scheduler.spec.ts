import { PreliminaryHoldExpiryScheduler } from './preliminary-hold-expiry.scheduler';
import { InventoryReservationContract } from '../../../foundation/module-registry/contracts/inventory.contract';
import { SalesOrdersService } from './sales-orders.service';
import { CompanyConnectionManagerService } from '../../../foundation/database-registry/company-connection-manager.service';
import { DataSource } from 'typeorm';

describe('PreliminaryHoldExpiryScheduler.runOnce — Multi-Company Area 9 (per-Company sweep, not ambient)', () => {
  let scheduler: PreliminaryHoldExpiryScheduler;
  const inventoryMock = { findExpiredPreliminaryHoldOrderIds: jest.fn() };
  const salesOrdersMock = { expireHoldForOrder: jest.fn() };
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
    scheduler = new PreliminaryHoldExpiryScheduler(
      inventoryMock as unknown as InventoryReservationContract,
      salesOrdersMock as unknown as SalesOrdersService,
      connectionsMock as unknown as CompanyConnectionManagerService,
      platformMock as unknown as DataSource,
    );
  });

  it('sweeps every ACTIVE Company\'s own connection, never the ambient one', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-1', 'company-2']);
    const managerA = { tag: 'manager-a' };
    const managerB = { tag: 'manager-b' };
    connectionsMock.getDataSource.mockImplementation(async (id: string) => ({ manager: id === 'company-1' ? managerA : managerB }));
    inventoryMock.findExpiredPreliminaryHoldOrderIds.mockImplementation(async (_cutoff: Date, manager: unknown) =>
      manager === managerA ? ['order-a1'] : ['order-b1'],
    );
    salesOrdersMock.expireHoldForOrder.mockResolvedValue(undefined);

    await scheduler.runOnce();

    expect(inventoryMock.findExpiredPreliminaryHoldOrderIds).toHaveBeenCalledWith(expect.any(Date), managerA);
    expect(inventoryMock.findExpiredPreliminaryHoldOrderIds).toHaveBeenCalledWith(expect.any(Date), managerB);
    expect(salesOrdersMock.expireHoldForOrder).toHaveBeenCalledWith('order-a1', null, managerA);
    expect(salesOrdersMock.expireHoldForOrder).toHaveBeenCalledWith('order-b1', null, managerB);
  });

  it('one order failing does not stop the sweep for the rest of that Company or other Companies', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-1']);
    connectionsMock.getDataSource.mockResolvedValue({ manager: 'm1' });
    inventoryMock.findExpiredPreliminaryHoldOrderIds.mockResolvedValue(['order-1', 'order-2']);
    salesOrdersMock.expireHoldForOrder.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    await expect(scheduler.runOnce()).resolves.toBeUndefined();
    expect(salesOrdersMock.expireHoldForOrder).toHaveBeenCalledTimes(2);
  });

  it('a Company whose database is not ACTIVE (getDataSource throws) is skipped, not fatal to the sweep', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-1', 'company-2']);
    connectionsMock.getDataSource.mockRejectedValueOnce(new Error('not ACTIVE')).mockResolvedValueOnce({ manager: 'm2' });
    inventoryMock.findExpiredPreliminaryHoldOrderIds.mockResolvedValue([]);

    await scheduler.runOnce();

    expect(inventoryMock.findExpiredPreliminaryHoldOrderIds).toHaveBeenCalledTimes(1);
  });

  it('LA-1 Layer 2: a Company that is not READY at execution time is skipped — its DataSource is never requested — while the other Company in the same sweep still runs', async () => {
    connectionsMock.listActiveCompanyIds.mockResolvedValue(['company-1', 'company-2']);
    platformStatus['company-1'] = 'SUSPENDED';
    connectionsMock.getDataSource.mockImplementation(async (id: string) => ({ manager: `m-${id}` }));
    inventoryMock.findExpiredPreliminaryHoldOrderIds.mockResolvedValue(['order-x']);
    salesOrdersMock.expireHoldForOrder.mockResolvedValue(undefined);

    await scheduler.runOnce();

    expect(connectionsMock.getDataSource).not.toHaveBeenCalledWith('company-1');
    expect(connectionsMock.getDataSource).toHaveBeenCalledWith('company-2');
    expect(salesOrdersMock.expireHoldForOrder).toHaveBeenCalledTimes(1);
    expect(salesOrdersMock.expireHoldForOrder).toHaveBeenCalledWith('order-x', null, 'm-company-2');
  });
});
