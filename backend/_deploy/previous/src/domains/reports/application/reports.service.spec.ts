import { Test } from '@nestjs/testing';
import { ReportsService } from './reports.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { CustomersService } from '../../crm/application/customers.service';
import { DepositsService } from '../../deposit-control/application/deposits.service';
import { UsersService } from '../../../foundation/identity/users.service';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { DeliveryService } from '../../delivery/application/delivery.service';

/**
 * Operational Reports — proves the report rows are pure composition/
 * aggregation over each domain's own already-trusted data (never a
 * recomputed business rule), and that Scope enforcement is inherited
 * for free from `SalesOrdersService.listOrders` (this service is never
 * given the chance to see an order outside the caller's scope, because
 * the mock itself only returns what a real Scope-filtered call would).
 */
describe('ReportsService', () => {
  let service: ReportsService;

  const order = (overrides: Partial<{ id: string; orderNumber: string; customerId: string; salesRepUserId: string; totalAmount: string; workflowPolicy: string; createdAt: Date }>) => ({
    id: 'so-1',
    orderNumber: 'SO-2026-000001',
    customerId: 'cust-1',
    salesRepUserId: 'rep-1',
    totalAmount: '100.00',
    workflowPolicy: 'standard',
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    ...overrides,
  });

  const salesOrdersMock = {
    listOrders: jest.fn(async () => [
      order({ id: 'so-1', orderNumber: 'SO-2026-000001', customerId: 'cust-1', salesRepUserId: 'rep-1', totalAmount: '100.00', createdAt: new Date('2026-01-15T10:00:00.000Z') }),
      order({ id: 'so-2', orderNumber: 'SO-2026-000002', customerId: 'cust-1', salesRepUserId: 'rep-2', totalAmount: '50.00', createdAt: new Date('2026-01-20T10:00:00.000Z') }),
      order({ id: 'so-3', orderNumber: 'SO-2026-000003', customerId: 'cust-2', salesRepUserId: 'rep-1', totalAmount: '25.00', createdAt: new Date('2026-02-01T10:00:00.000Z') }),
    ]),
    getOrderStatus: jest.fn(async (orderId: string) => (orderId === 'so-1' ? 'released' : 'draft')),
  };

  const customersMock = {
    listCustomers: jest.fn(async () => [
      { id: 'cust-1', name: 'Acme Trading' },
      { id: 'cust-2', name: 'Beta Foods' },
    ]),
  };

  const depositsMock = {
    getLatestDepositForOrder: jest.fn(async (orderId: string) =>
      orderId === 'so-1' ? { status: 'approved', amount: '20.00' } : null,
    ),
  };

  const usersMock = {
    findById: jest.fn(async (id: string) => {
      if (id === 'rep-1') return { id, fullName: 'Sales Rep One' };
      if (id === 'rep-2') return { id, fullName: 'Sales Rep Two' };
      throw new Error('not found');
    }),
  };

  const shipmentsMock = {
    listShippingCompanies: jest.fn(async () => [
      { id: 'co-1', code: 'DHL', name: 'DHL Express', custodyAccountId: 'custody-co-1' },
      { id: 'co-2', code: 'NOACC', name: 'No Custody Account Co', custodyAccountId: null },
    ]),
    listVehicles: jest.fn(async () => [{ id: 'veh-1', code: 'V-1', plateNumber: 'XYZ-123', custodyAccountId: 'custody-veh-1' }]),
    getCustodianOverview: jest.fn(async (type: 'company' | 'vehicle', id: string) => {
      if (type === 'company' && id === 'co-1') return { custodyBalance: '500.00', activeShipmentsCount: 3 };
      if (type === 'vehicle' && id === 'veh-1') return { custodyBalance: '100.00', activeShipmentsCount: 1 };
      return { custodyBalance: '0.00', activeShipmentsCount: 0 };
    }),
  };

  const deliveryMock = {
    listAllCollections: jest.fn(async () => [
      { id: 'col-1', custodyAccountId: 'custody-co-1', amount: '200.00', remittanceStatus: 'remitted' },
      { id: 'col-2', custodyAccountId: 'custody-co-1', amount: '150.00', remittanceStatus: 'pending' },
      { id: 'col-3', custodyAccountId: 'custody-veh-1', amount: '80.00', remittanceStatus: 'pending' },
      { id: 'col-4', custodyAccountId: null, amount: '999.00', remittanceStatus: 'remitted' },
    ]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: SalesOrdersService, useValue: salesOrdersMock },
        { provide: CustomersService, useValue: customersMock },
        { provide: DepositsService, useValue: depositsMock },
        { provide: UsersService, useValue: usersMock },
        { provide: ShipmentService, useValue: shipmentsMock },
        { provide: DeliveryService, useValue: deliveryMock },
      ],
    }).compile();
    service = moduleRef.get(ReportsService);
  });

  it('getSalesOrdersReport enriches each order with customer/rep names, status, and deposit info — nothing recomputed', async () => {
    const rows = await service.getSalesOrdersReport('actor-1');
    expect(rows).toHaveLength(3);
    const row1 = rows.find((r) => r.id === 'so-1')!;
    expect(row1.customerName).toBe('Acme Trading');
    expect(row1.salesRepName).toBe('Sales Rep One');
    expect(row1.status).toBe('released');
    expect(row1.depositStatus).toBe('approved');
    expect(row1.depositAmount).toBe('20.00');
    expect(row1.totalAmount).toBe('100.00'); // same value listOrders returned — never recalculated

    const row2 = rows.find((r) => r.id === 'so-2')!;
    expect(row2.depositStatus).toBeNull(); // no deposit submitted yet
  });

  it('inherits Scope from SalesOrdersService.listOrders — never queries orders itself', async () => {
    await service.getSalesOrdersReport('rep-1');
    expect(salesOrdersMock.listOrders).toHaveBeenCalledWith('rep-1');
  });

  it('getSalesByPeriod groups by day and sums totals correctly', async () => {
    const rows = await service.getSalesByPeriod('actor-1', 'day');
    expect(rows).toEqual([
      { period: '2026-01-15', orderCount: 1, totalAmount: '100.00' },
      { period: '2026-01-20', orderCount: 1, totalAmount: '50.00' },
      { period: '2026-02-01', orderCount: 1, totalAmount: '25.00' },
    ]);
  });

  it('getSalesByPeriod groups by month when asked', async () => {
    const rows = await service.getSalesByPeriod('actor-1', 'month');
    expect(rows).toEqual([
      { period: '2026-01', orderCount: 2, totalAmount: '150.00' },
      { period: '2026-02', orderCount: 1, totalAmount: '25.00' },
    ]);
  });

  it('getSalesByCustomer groups and sorts by total descending', async () => {
    const rows = await service.getSalesByCustomer('actor-1');
    expect(rows).toEqual([
      { customerId: 'cust-1', customerName: 'Acme Trading', orderCount: 2, totalAmount: '150.00' },
      { customerId: 'cust-2', customerName: 'Beta Foods', orderCount: 1, totalAmount: '25.00' },
    ]);
  });

  it('getSalesByRep groups and sorts by total descending', async () => {
    const rows = await service.getSalesByRep('actor-1');
    expect(rows).toEqual([
      { salesRepUserId: 'rep-1', salesRepName: 'Sales Rep One', orderCount: 2, totalAmount: '125.00' },
      { salesRepUserId: 'rep-2', salesRepName: 'Sales Rep Two', orderCount: 1, totalAmount: '50.00' },
    ]);
  });

  describe('getCustodyCodReport', () => {
    it('groups collections to their custodian by custodyAccountId, skips custodians with no custody account, and ignores custodian-less collections', async () => {
      const report = await service.getCustodyCodReport();
      expect(report.rows).toHaveLength(2); // co-2 has no custodyAccountId — excluded

      const companyRow = report.rows.find((r) => r.custodianId === 'co-1')!;
      expect(companyRow.custodianType).toBe('company');
      expect(companyRow.custodianName).toBe('DHL Express');
      expect(companyRow.custodyBalance).toBe('500.00');
      expect(companyRow.activeShipmentsCount).toBe(3);
      expect(companyRow.codCollectedTotal).toBe('350.00'); // col-1 + col-2
      expect(companyRow.codPendingTotal).toBe('150.00');
      expect(companyRow.codRemittedTotal).toBe('200.00');

      const vehicleRow = report.rows.find((r) => r.custodianId === 'veh-1')!;
      expect(vehicleRow.custodianType).toBe('vehicle');
      expect(vehicleRow.custodianName).toBe('XYZ-123'); // vehicle name = plate number
      expect(vehicleRow.codCollectedTotal).toBe('80.00');
      expect(vehicleRow.codPendingTotal).toBe('80.00');
      expect(vehicleRow.codRemittedTotal).toBe('0.00');

      // col-4 (custodyAccountId: null, 999.00) never appears anywhere — proves it's excluded, not silently dropped into a wrong bucket.
      const totalCollected = report.rows.reduce((sum, r) => sum + Number(r.codCollectedTotal), 0);
      expect(totalCollected).toBe(430.0);
    });

    it('sums totals across every custodian row', async () => {
      const report = await service.getCustodyCodReport();
      expect(report.totals).toEqual({
        custodyBalance: '600.00',
        codCollectedTotal: '430.00',
        codPendingTotal: '230.00',
        codRemittedTotal: '200.00',
      });
    });
  });
});
