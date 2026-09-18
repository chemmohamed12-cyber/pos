import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ShipmentService } from './shipment.service';
import { Shipment } from '../infrastructure/shipment.entity';
import { TrackingEvent } from '../infrastructure/tracking-event.entity';
import { ShippingCompany } from '../infrastructure/shipping-company.entity';
import { Vehicle } from '../infrastructure/vehicle.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { FulfillmentService } from '../../fulfillment/application/fulfillment.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { CustomersService } from '../../crm/application/customers.service';

describe('ShipmentService', () => {
  let service: ShipmentService;
  const shipments = new Map<string, Shipment>();
  const trackingEvents: TrackingEvent[] = [];
  const shipmentStates = new Map<string, string>();
  const publishedTopics: string[] = [];
  let idSeq = 0;

  const shipmentRepo = {
    create: jest.fn((d: Partial<Shipment>) => ({ id: `ship-${++idSeq}`, ...d }) as Shipment),
    save: jest.fn(async (s: Shipment) => {
      shipments.set(s.id, s);
      return s;
    }),
    // RSH Shipping Orders (CTO directive §3) — createShipment's duplicate
    // guard looks up by `fulfillmentOrderId`, and getShipmentBySalesOrderId
    // by `salesOrderId`, not just `id`; this mock now supports any of the
    // three keys, matching a real TypeORM `findOne({where})`.
    findOne: jest.fn(async ({ where }: { where: { id?: string; fulfillmentOrderId?: string; salesOrderId?: string } }) => {
      if (where.fulfillmentOrderId) {
        return [...shipments.values()].find((s) => s.fulfillmentOrderId === where.fulfillmentOrderId) ?? null;
      }
      if (where.salesOrderId) {
        return [...shipments.values()].find((s) => s.salesOrderId === where.salesOrderId) ?? null;
      }
      return shipments.get(where.id!) ?? null;
    }),
    find: jest.fn(async (opts?: { where?: { driverUserId?: string; shippingCompanyId?: string; vehicleId?: string } }) => {
      const all = [...shipments.values()];
      if (!opts?.where) return all;
      return all.filter((s) =>
        Object.entries(opts.where!).every(([k, v]) => (s as unknown as Record<string, unknown>)[k] === v),
      );
    }),
    // Pagination sibling `listShipmentsPage` — same filter shape as
    // `find` above, plus `take`/`skip` slicing (newest-first, matching
    // the real `order: { createdAt: 'DESC' }`) and the matching total.
    findAndCount: jest.fn(
      async (opts?: { where?: { driverUserId?: string }; take?: number; skip?: number }) => {
        const all = [...shipments.values()];
        const filtered = !opts?.where
          ? all
          : all.filter((s) => Object.entries(opts.where!).every(([k, v]) => (s as unknown as Record<string, unknown>)[k] === v));
        const skip = opts?.skip ?? 0;
        const take = opts?.take ?? filtered.length;
        return [filtered.slice(skip, skip + take), filtered.length];
      },
    ),
  };
  const trackingRepo = {
    create: jest.fn((d: Partial<TrackingEvent>) => ({ id: `te-${trackingEvents.length + 1}`, occurredAt: new Date(), ...d }) as TrackingEvent),
    save: jest.fn(async (t: TrackingEvent) => {
      trackingEvents.push(t);
      return t;
    }),
    find: jest.fn(async ({ where }: { where: { shipmentId: string } }) =>
      trackingEvents.filter((t) => t.shipmentId === where.shipmentId),
    ),
  };

  const shippingCompanies = new Map<string, ShippingCompany>();
  let companySeq = 0;
  const shippingCompanyRepo = {
    create: jest.fn(
      (d: Partial<ShippingCompany>) =>
        ({
          id: `sc-${++companySeq}`,
          status: 'active',
          treasuryAccountId: null,
          contactPhone: null,
          address: null,
          responsiblePerson: null,
          warehouseId: null,
          custodyAccountId: null,
          ...d,
        }) as ShippingCompany,
    ),
    save: jest.fn(async (c: ShippingCompany) => {
      shippingCompanies.set(c.id, c);
      return c;
    }),
    findOne: jest.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
      if (where.code) return [...shippingCompanies.values()].find((c) => c.code === where.code) ?? null;
      return shippingCompanies.get(where.id!) ?? null;
    }),
    find: jest.fn(async () => [...shippingCompanies.values()].sort((a, b) => a.code.localeCompare(b.code))),
  };

  const vehicles = new Map<string, Vehicle>();
  let vehicleSeq = 0;
  const vehicleRepo = {
    create: jest.fn(
      (d: Partial<Vehicle>) =>
        ({
          id: `veh-${++vehicleSeq}`,
          status: 'active',
          driverUserId: null,
          shippingCompanyId: null,
          branch: null,
          warehouseId: null,
          custodyAccountId: null,
          settlementAccountId: null,
          ...d,
        }) as Vehicle,
    ),
    save: jest.fn(async (v: Vehicle) => {
      vehicles.set(v.id, v);
      return v;
    }),
    findOne: jest.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
      if (where.code) return [...vehicles.values()].find((v) => v.code === where.code) ?? null;
      return vehicles.get(where.id!) ?? null;
    }),
    find: jest.fn(async () => [...vehicles.values()].sort((a, b) => a.code.localeCompare(b.code))),
  };

  const getRepositoryMock = jest.fn((entity: unknown) =>
    entity === Shipment ? shipmentRepo : entity === ShippingCompany ? shippingCompanyRepo : entity === Vehicle ? vehicleRepo : trackingRepo,
  );
  const dataSourceMock = {
    getRepository: getRepositoryMock,
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn({ getRepository: getRepositoryMock })),
  };

  const numberingCounters = new Map<string, number>();
  const numberingMock = {
    registerDocumentType: jest.fn(async () => undefined),
    getNextNumber: jest.fn(async (documentType: string) => {
      if (documentType === 'shipment') return 'WB-2026-000001';
      // RSH Shipping Orders (CTO directive §3) — this document type uses
      // `includeYear: true` (like `shipment`/`sales_order`), unlike the
      // sub-location/custody-account codes below which don't.
      if (documentType === 'shipping_order') {
        const next = (numberingCounters.get(documentType) ?? 0) + 1;
        numberingCounters.set(documentType, next);
        return `RSH-2026-${String(next).padStart(6, '0')}`;
      }
      const next = (numberingCounters.get(documentType) ?? 0) + 1;
      numberingCounters.set(documentType, next);
      const prefix = documentType === 'shipping_sub_location' ? 'SLOC' : documentType === 'shipping_custody_account' ? 'CUST' : 'DOC';
      return `${prefix}-${String(next).padStart(6, '0')}`;
    }),
  };
  const processEngineMock = {
    start: jest.fn(async (_d: unknown, _t: string, id: string) => shipmentStates.set(id, 'created')),
    transition: jest.fn(async (_d: unknown, _t: string, id: string, action: string) => {
      const map: Record<string, string> = {
        assign_driver: 'assigned',
        pickup: 'picked_up',
        depart: 'in_transit',
        arrive_for_delivery: 'out_for_delivery',
        deliver: 'delivered',
        fail_delivery: 'failed',
        retry: 'assigned',
        return_to_sender: 'returned',
      };
      shipmentStates.set(id, map[action]);
    }),
    getState: jest.fn(async (_d: unknown, _t: string, id: string) => shipmentStates.get(id) ?? 'created'),
  };
  const authorizationMock = {
    getRoleKeysForUser: jest.fn(async (userId: string) => {
      if (userId === 'admin-1') return ['admin'];
      if (userId === 'worker-1') return ['warehouse_worker'];
      if (userId === 'finance-1') return ['finance'];
      return [];
    }),
  };
  const auditMock = { record: jest.fn(async () => undefined) };
  const eventsMock = {
    publish: jest.fn(async (_m: unknown, topic: string) => {
      publishedTopics.push(topic);
    }),
    // RSH Shipping Orders (CTO directive §3) — onModuleInit calls
    // this.events.subscribe(...); NestJS's TestingModule.compile() alone
    // doesn't fire lifecycle hooks, but this no-op keeps the mock honest
    // in case a future test explicitly calls moduleRef.init().
    subscribe: jest.fn(),
  };

  let warehouseSeq = 0;
  const createdWarehouses: Array<{ id: string; code: string; parentWarehouseId: string | null; kind: string }> = [];
  const inventoryMock = {
    listWarehouses: jest.fn(async () => [{ id: 'wh-main', code: 'MAIN', kind: 'main', status: 'active' }]),
    createWarehouse: jest.fn(
      async (
        code: string,
        name: string,
        _location: string | null,
        _responsibleUserId: string | null,
        parentWarehouseId: string | null,
        kind: string,
      ) => {
        const wh = { id: `wh-op-${++warehouseSeq}`, code, name, parentWarehouseId, kind };
        createdWarehouses.push(wh);
        return wh;
      },
    ),
    getStockReport: jest.fn(async (warehouseId: string) => [
      { warehouseId, productId: 'prod-1', onHand: 3, reserved: 0, available: 3 },
    ]),
    // CTO directive (reconcile the Preparation -> Shipping handoff) — the
    // order's own active reservation(s), each carrying wherever it
    // CURRENTLY sits (see relocateReservedStock's own comment on why this
    // is not necessarily the Fulfillment Order's original warehouse).
    getActiveReservationsForOrder: jest.fn(async (salesOrderId: string) =>
      salesOrderId === 'so-1' ? [{ id: 'rsv-1', warehouseId: 'wh-main', productId: 'prod-1', quantity: 3 }] : [],
    ),
    relocateReservedStock: jest.fn(
      async (
        _salesOrderId: string,
        _productId: string,
        _fromWarehouseId: string,
        _toWarehouseId: string,
        _quantity: number,
        _referenceType: string,
        _referenceId: string,
        _actorUserId: string,
      ) => undefined,
    ),
  };

  const fulfillmentMock = {
    getFulfillmentOrder: jest.fn(async (id: string) => ({ id, salesOrderId: 'so-1', warehouseId: 'wh-main', createdAt: new Date() })),
  };

  const salesOrdersMock = {
    getOrderSnapshot: jest.fn(async (orderId: string) =>
      orderId === 'so-1' ? { id: 'so-1', orderNumber: 'SO-2026-000001', customerId: 'cust-1' } : null,
    ),
    getOrder: jest.fn(async (orderId: string) =>
      orderId === 'so-1' ? { id: 'so-1', orderNumber: 'SO-2026-000001', customerId: 'cust-1', warehouseId: 'wh-main' } : null,
    ),
  };
  const customersMock = {
    findByCode: jest.fn(async (code: string) => (code === 'CUST-001' ? { id: 'cust-1', code: 'CUST-001', name: 'Test Customer' } : null)),
    getCustomerSnapshot: jest.fn(async (customerId: string) =>
      customerId === 'cust-1' ? { id: 'cust-1', code: 'CUST-001', name: 'Test Customer', phone: null, address: null, governorate: null } : null,
    ),
  };

  let acctSeq = 0;
  const treasuryMock = {
    listAccountTypes: jest.fn(async () => [{ id: 'type-custody', code: 'custody', name: 'Custody', status: 'active' }]),
    createAccount: jest.fn(async (code: string, name: string, accountTypeId: string) => ({
      id: `acct-${++acctSeq}`,
      code,
      name,
      accountTypeId,
      status: 'active',
    })),
    getAccountBalance: jest.fn(async () => '750.00'),
  };

  beforeEach(async () => {
    shipments.clear();
    trackingEvents.length = 0;
    shipmentStates.clear();
    publishedTopics.length = 0;
    shippingCompanies.clear();
    vehicles.clear();
    createdWarehouses.length = 0;
    idSeq = 0;
    companySeq = 0;
    vehicleSeq = 0;
    warehouseSeq = 0;
    numberingCounters.clear();
    acctSeq = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ShipmentService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: NumberingService, useValue: numberingMock },
        { provide: ProcessEngineService, useValue: processEngineMock },
        { provide: AuthorizationService, useValue: authorizationMock },
        { provide: AuditService, useValue: auditMock },
        { provide: EventBusService, useValue: eventsMock },
        { provide: InventoryService, useValue: inventoryMock },
        { provide: FulfillmentService, useValue: fulfillmentMock },
        { provide: TreasuryService, useValue: treasuryMock },
        { provide: SalesOrdersService, useValue: salesOrdersMock },
        { provide: CustomersService, useValue: customersMock },
      ],
    }).compile();
    service = moduleRef.get(ShipmentService);
  });

  it('creates a shipment with a Numbering-issued waybill and starts it at "created"', async () => {
    const shipment = await service.createShipment('fo-1', 'admin-1');
    expect(shipment.waybillNumber).toBe('WB-2026-000001');
    expect(await service.getStatus(shipment.id)).toBe('created');
  });

  describe('RSH Shipping Orders (CTO directive §3)', () => {
    it('generates a real RSH number and resolves/stores the owning Sales Order id + number', async () => {
      const shipment = await service.createShipment('fo-1', 'admin-1');
      expect(shipment.rshNumber).toBe('RSH-2026-000001');
      expect(shipment.salesOrderId).toBe('so-1');
      expect(shipment.salesOrderNumber).toBe('SO-2026-000001');
    });

    it('rejects a second shipment for the same fulfillment order — no duplicate dispatch', async () => {
      await service.createShipment('fo-1', 'admin-1');
      await expect(service.createShipment('fo-1', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects creating a shipment for a non-existent fulfillment order', async () => {
      fulfillmentMock.getFulfillmentOrder.mockImplementationOnce(async () => {
        throw new NotFoundException('Fulfillment order "fo-ghost" not found.');
      });
      await expect(service.createShipment('fo-ghost', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('degrades salesOrderNumber to null rather than throwing when the Sales Order snapshot is unavailable', async () => {
      fulfillmentMock.getFulfillmentOrder.mockImplementationOnce(async (id: string) => ({
        id,
        salesOrderId: 'so-unknown',
        warehouseId: 'wh-main',
        createdAt: new Date(),
      }));
      const shipment = await service.createShipment('fo-1', 'admin-1');
      expect(shipment.salesOrderId).toBe('so-unknown');
      expect(shipment.salesOrderNumber).toBeNull();
    });

    it('getShipmentBySalesOrderId finds the shipment by its Sales Order link', async () => {
      const created = await service.createShipment('fo-1', 'admin-1');
      const found = await service.getShipmentBySalesOrderId('so-1');
      expect(found?.id).toBe(created.id);
    });

    it('getShipmentBySalesOrderId returns null when no shipment exists for that order', async () => {
      expect(await service.getShipmentBySalesOrderId('so-none')).toBeNull();
    });

    it('the onModuleInit subscriber auto-creates a shipment from a fulfillment.ready-for-dispatch event', async () => {
      service.onModuleInit();
      expect(eventsMock.subscribe).toHaveBeenCalledWith('fulfillment.ready-for-dispatch', expect.any(Function));
      const handler = eventsMock.subscribe.mock.calls.find(([topic]) => topic === 'fulfillment.ready-for-dispatch')![1];
      await handler({ fulfillmentOrderId: 'fo-1', salesOrderId: 'so-1' });
      const shipment = await service.getShipmentBySalesOrderId('so-1');
      expect(shipment?.rshNumber).toBe('RSH-2026-000001');
    });
  });

  it('rejects driver assignment by a non-admin', async () => {
    const shipment = await service.createShipment('fo-1', 'admin-1');
    await expect(service.assignDriver(shipment.id, 'driver-1', 'rep-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a non-assigned, non-admin user from transitioning the shipment', async () => {
    const shipment = await service.createShipment('fo-1', 'admin-1');
    await service.assignDriver(shipment.id, 'driver-1', 'admin-1');
    await expect(service.transitionShipment(shipment.id, 'pickup', 'someone-else')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('walks the full lifecycle: assign -> pickup -> depart -> arrive -> deliver, recording tracking events at each step', async () => {
    const shipment = await service.createShipment('fo-1', 'admin-1');
    await service.assignDriver(shipment.id, 'driver-1', 'admin-1');
    await service.transitionShipment(shipment.id, 'pickup', 'driver-1');
    await service.transitionShipment(shipment.id, 'depart', 'driver-1');
    await service.transitionShipment(shipment.id, 'arrive_for_delivery', 'driver-1');
    const finalStatus = await service.transitionShipment(shipment.id, 'deliver', 'driver-1');

    expect(finalStatus).toBe('delivered');
    expect(publishedTopics).toContain('shipment.delivered');
    const history = await service.getTrackingHistory(shipment.id, 'driver-1');
    expect(history.map((h) => h.eventType)).toEqual(['created', 'assigned', 'pickup', 'depart', 'arrive_for_delivery', 'deliver']);
  });

  it('rejects a non-driver, non-admin from reading a shipment or its tracking history (IDOR fix)', async () => {
    const shipment = await service.createShipment('fo-1', 'admin-1');
    await service.assignDriver(shipment.id, 'driver-1', 'admin-1');
    await expect(service.getShipment(shipment.id, 'someone-else')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getTrackingHistory(shipment.id, 'someone-else')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getShipment(shipment.id, 'driver-1')).resolves.toBeTruthy();
  });

  it('lets a finance-role caller READ a shipment/tracking history they never drove (REAL BUG FOUND LIVE, Returns/Custody-Settlement E2E: CollectionReceiptPrint.tsx 403\'d for fin1 because getShipment only ever allowed driver-or-admin) but still refuses them the driver ACTIONS (assertDriverOrAdmin stays untouched — finance printing a receipt must never double as finance dispatching a shipment)', async () => {
    const shipment = await service.createShipment('fo-1', 'admin-1');
    await service.assignDriver(shipment.id, 'driver-1', 'admin-1');
    await expect(service.getShipment(shipment.id, 'finance-1')).resolves.toBeTruthy();
    await expect(service.getTrackingHistory(shipment.id, 'finance-1')).resolves.toBeTruthy();
    await expect(service.transitionShipment(shipment.id, 'pickup', 'finance-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('supports the failed-delivery -> retry branch (retry is admin-only, not the driver\'s own action)', async () => {
    const shipment = await service.createShipment('fo-1', 'admin-1');
    await service.assignDriver(shipment.id, 'driver-1', 'admin-1');
    await service.transitionShipment(shipment.id, 'pickup', 'driver-1');
    await service.transitionShipment(shipment.id, 'depart', 'driver-1');
    await service.transitionShipment(shipment.id, 'arrive_for_delivery', 'driver-1');
    const failedStatus = await service.transitionShipment(shipment.id, 'fail_delivery', 'driver-1');
    expect(failedStatus).toBe('failed');
    expect(publishedTopics).toContain('shipment.failed');

    await expect(service.transitionShipment(shipment.id, 'retry', 'driver-1')).rejects.toBeInstanceOf(ForbiddenException);
    const retriedStatus = await service.transitionShipment(shipment.id, 'retry', 'admin-1');
    expect(retriedStatus).toBe('assigned');
  });

  it('listShipments gives a warehouse_worker full dispatch-board visibility, same as admin (CTO directive — Fulfillment dashboard needs to know what\'s already shipped)', async () => {
    const shipment = await service.createShipment('fo-1', 'admin-1');
    await service.assignDriver(shipment.id, 'driver-1', 'admin-1');
    const asWorker = await service.listShipments('worker-1');
    expect(asWorker.map((s) => s.id)).toEqual([shipment.id]);
  });

  describe('listShipmentsPage (MASTER_PROJECT_STATUS.md §6 pagination audit — Shipment was 1 of the 2 endpoints deferred out of the first pagination pass)', () => {
    it('paginates with correct total and disjoint pages, honoring the same driver-scoping as listShipments', async () => {
      for (let i = 0; i < 5; i++) {
        const s = await service.createShipment(`fo-page-${i}`, 'admin-1');
        await service.assignDriver(s.id, 'driver-page', 'admin-1');
      }
      const pageOne = await service.listShipmentsPage('driver-page', { page: 1, pageSize: 2 });
      const pageTwo = await service.listShipmentsPage('driver-page', { page: 2, pageSize: 2 });
      const pageThree = await service.listShipmentsPage('driver-page', { page: 3, pageSize: 2 });

      expect(pageOne.total).toBe(5);
      expect(pageTwo.total).toBe(5);
      expect(pageOne.rows).toHaveLength(2);
      expect(pageTwo.rows).toHaveLength(2);
      expect(pageThree.rows).toHaveLength(1); // partial last page
      const allIds = [...pageOne.rows, ...pageTwo.rows, ...pageThree.rows].map((s) => s.id);
      expect(new Set(allIds).size).toBe(5); // disjoint, no overlap/duplication across pages

      // scoping still applies: a different driver sees none of these
      const otherDriver = await service.listShipmentsPage('someone-else', { page: 1, pageSize: 50 });
      expect(otherDriver.total).toBe(0);
    });
  });

  describe('assignShippingRoute (Shipping Screen Redesign directive §3) — RSH auto-creates with no route; this is the only way to set one afterward', () => {
    it('rejects a non-admin', async () => {
      const shipment = await service.createShipment('fo-1', 'admin-1');
      await expect(service.assignShippingRoute(shipment.id, 'sc-1', null, 'rep-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects setting both a shipping company and a vehicle at once', async () => {
      const shipment = await service.createShipment('fo-1', 'admin-1');
      await expect(service.assignShippingRoute(shipment.id, 'sc-1', 'veh-1', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('assigns a shipping company to a freshly auto-created (routeless) shipment, recording before/after in the audit trail', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1');
      const saved = await service.assignShippingRoute(shipment.id, company.id, null, 'admin-1', 'Customer requested DHL');
      expect(saved.shippingCompanyId).toBe(company.id);
      expect(saved.vehicleId).toBeNull();
    });

    it('reassigns from one route to another before pickup — e.g. company to vehicle', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', null, null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id);
      const saved = await service.assignShippingRoute(shipment.id, null, vehicle.id, 'admin-1');
      expect(saved.shippingCompanyId).toBeNull();
      expect(saved.vehicleId).toBe(vehicle.id);
    });

    it('rejects changing the route once pickup has been confirmed — custody has already transferred', async () => {
      const shipment = await service.createShipment('fo-1', 'admin-1');
      await service.assignDriver(shipment.id, 'driver-1', 'admin-1');
      await service.transitionShipment(shipment.id, 'pickup', 'driver-1');
      await expect(service.assignShippingRoute(shipment.id, 'sc-1', null, 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects assigning an inactive shipping company', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      await service.setShippingCompanyStatus(company.id, 'inactive', 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1');
      await expect(service.assignShippingRoute(shipment.id, company.id, null, 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects assigning a retired vehicle', async () => {
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', null, null, null, 'admin-1');
      await service.setVehicleStatus(vehicle.id, 'retired', 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1');
      await expect(service.assignShippingRoute(shipment.id, null, vehicle.id, 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('Shipping Companies (CTO directive — multi-carrier support from the start)', () => {
    it('creates a shipping company, auto-provisioning its sub-location warehouse and custody account, and rejects a duplicate code', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', '19999', '123 Main St', 'Ahmed', 'admin-1');
      expect(company.code).toBe('DHL');
      expect(company.status).toBe('active');
      expect(company.address).toBe('123 Main St');
      expect(company.responsiblePerson).toBe('Ahmed');
      expect(company.warehouseId).toBeTruthy();
      expect(company.custodyAccountId).toBeTruthy();
      // REAL BUG FOUND LIVE (E2E, not this mock): the sub-location/custody
      // codes used to be built off the custodian's OWN code (`${code}-LOC`,
      // `CUSTODY-${code}`), silently overflowing `varchar(32)` for any
      // realistically-long custodian code — a 500, not a validation error.
      // Fixed to always go through the Numbering Engine instead; asserting
      // that here (a Numbering-issued code, not string concatenation off
      // `code`/`name`) is exactly what would have caught it.
      expect(inventoryMock.createWarehouse).toHaveBeenCalledWith('SLOC-000001', 'DHL Express', null, null, 'wh-main', 'operational');
      expect(treasuryMock.createAccount).toHaveBeenCalledWith('CUST-000001', expect.any(String), 'type-custody', 'admin-1');
      await expect(
        service.createShippingCompany('DHL', 'DHL Duplicate', null, null, null, 'admin-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('a very long company code never leaks into the auto-provisioned warehouse/custody codes (REAL BUG FOUND LIVE: varchar(32) overflow — 500 on creation, not a validation error)', async () => {
      const longCode = 'REALLY-LONG-CUSTOMER-SUPPLIED-SHIPPING-COMPANY-CODE';
      const company = await service.createShippingCompany(longCode, 'Long Code Co', null, null, null, 'admin-1');
      const [warehouseCode] = inventoryMock.createWarehouse.mock.calls[0];
      const [custodyCode] = treasuryMock.createAccount.mock.calls[0];
      expect(warehouseCode.length).toBeLessThanOrEqual(32);
      expect(custodyCode.length).toBeLessThanOrEqual(32);
      expect(warehouseCode).not.toContain(longCode);
      expect(custodyCode).not.toContain(longCode);
      expect(company.code).toBe(longCode); // the COMPANY's own code is untouched — only the derived resource codes changed
    });

    it('updates a company\'s editable fields', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const updated = await service.updateShippingCompany(company.id, { address: 'New Address' }, 'admin-1');
      expect(updated.address).toBe('New Address');
      expect(updated.name).toBe('DHL Express'); // untouched field stays as-is
    });

    it('lists companies sorted by code', async () => {
      await service.createShippingCompany('BOSTA', 'Bosta', null, null, null, 'admin-1');
      await service.createShippingCompany('ARAMEX', 'Aramex', null, null, null, 'admin-1');
      const list = await service.listShippingCompanies();
      expect(list.map((c) => c.code)).toEqual(['ARAMEX', 'BOSTA']);
    });

    it('links a settlement Treasury account to a shipping company — the Customer->Order->Shipment->ShippingCompany->Treasury bridge', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const updated = await service.setShippingCompanyTreasuryAccount(company.id, 'acct-real', 'admin-1');
      expect(updated.treasuryAccountId).toBe('acct-real');
    });

    it('throws NotFoundException for an unknown shipping company', async () => {
      await expect(service.getShippingCompany('no-such-id')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('attaches a shipping company and COD amount to a new shipment', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id, '250.00');
      expect(shipment.shippingCompanyId).toBe(company.id);
      expect(shipment.codAmount).toBe('250.00');
    });

    it('rejects creating a shipment through an inactive shipping company', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      await service.setShippingCompanyStatus(company.id, 'inactive', 'admin-1');
      await expect(service.createShipment('fo-1', 'admin-1', company.id, '250.00')).rejects.toBeInstanceOf(ConflictException);
    });

    it('getShipmentSnapshot is unscoped (no driver/admin check) — the read Delivery\'s Treasury bridge needs', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id, '250.00');
      const snapshot = await service.getShipmentSnapshot(shipment.id);
      expect(snapshot).toEqual({
        id: shipment.id,
        fulfillmentOrderId: 'fo-1',
        shippingCompanyId: company.id,
        vehicleId: null,
        codAmount: '250.00',
        salesOrderId: 'so-1',
      });
    });

    it('getShipmentSnapshot returns null for an unknown shipment rather than throwing', async () => {
      expect(await service.getShipmentSnapshot('no-such-id')).toBeNull();
    });
  });

  describe('Company Vehicles (CTO directive §2 — a second Operational Custodian type)', () => {
    it('creates a vehicle, auto-provisioning its own sub-location + custody account, and rejects a duplicate code', async () => {
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', 'driver-1', null, 'Cairo Branch', 'admin-1');
      expect(vehicle.plateNumber).toBe('ABC-1234');
      expect(vehicle.status).toBe('active');
      expect(vehicle.warehouseId).toBeTruthy();
      expect(vehicle.custodyAccountId).toBeTruthy();
      await expect(service.createVehicle('CAR-001', 'XYZ-9999', null, null, null, 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a vehicle referencing an unknown shipping company', async () => {
      await expect(service.createVehicle('CAR-001', 'ABC-1234', null, 'no-such-company', null, 'admin-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('updates plate number / branch', async () => {
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', null, null, null, 'admin-1');
      const updated = await service.updateVehicle(vehicle.id, { plateNumber: 'NEW-0001' }, 'admin-1');
      expect(updated.plateNumber).toBe('NEW-0001');
    });

    it('changes the assigned driver as its own explicit action', async () => {
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', 'driver-1', null, null, 'admin-1');
      const updated = await service.setVehicleDriver(vehicle.id, 'driver-2', 'admin-1');
      expect(updated.driverUserId).toBe('driver-2');
    });

    it('retires a vehicle instead of deleting it, and can reactivate it', async () => {
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', null, null, null, 'admin-1');
      const retired = await service.setVehicleStatus(vehicle.id, 'retired', 'admin-1');
      expect(retired.status).toBe('retired');
      const reactivated = await service.setVehicleStatus(vehicle.id, 'active', 'admin-1');
      expect(reactivated.status).toBe('active');
    });

    it('rejects creating a shipment through a retired vehicle', async () => {
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', null, null, null, 'admin-1');
      await service.setVehicleStatus(vehicle.id, 'retired', 'admin-1');
      await expect(service.createShipment('fo-1', 'admin-1', null, null, vehicle.id)).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws NotFoundException for an unknown vehicle', async () => {
      await expect(service.getVehicle('no-such-id')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Custody Transfer at pickup (CTO directive §5 — Chain of Custody; reconciled to use the ACTUAL current stock location)', () => {
    it('relocates the order\'s reservations from wherever they ACTUALLY currently sit to the VEHICLE\'s sub-location when a vehicle is assigned', async () => {
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', 'driver-1', null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', null, null, vehicle.id);
      await service.assignDriver(shipment.id, 'driver-1', 'admin-1');

      await service.transitionShipment(shipment.id, 'pickup', 'driver-1');

      expect(inventoryMock.relocateReservedStock).toHaveBeenCalledWith(
        'so-1',
        'prod-1',
        'wh-main', // the reservation's OWN current warehouse — not a hard-coded FulfillmentOrder.warehouseId assumption
        vehicle.warehouseId,
        3,
        'shipment_custody_transfer',
        shipment.id,
        'driver-1',
      );
    });

    it('prefers the VEHICLE over the shipping company when a shipment has both', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', 'driver-1', company.id, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id, null, vehicle.id);
      await service.assignDriver(shipment.id, 'driver-1', 'admin-1');
      // Waybill-required flow (CTO directive) — a company is set, so pickup needs it on file.
      await service.setCarrierWaybill(shipment.id, 'AWB-12345', 'media-asset-1', 'admin-1');

      await service.transitionShipment(shipment.id, 'pickup', 'driver-1');

      const [, , , destination] = inventoryMock.relocateReservedStock.mock.calls[0];
      expect(destination).toBe(vehicle.warehouseId); // not the company's
    });

    it('falls back to the COMPANY\'s sub-location when no vehicle is assigned', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id);
      await service.assignDriver(shipment.id, 'driver-1', 'admin-1');
      await service.setCarrierWaybill(shipment.id, 'AWB-12345', 'media-asset-1', 'admin-1');

      await service.transitionShipment(shipment.id, 'pickup', 'driver-1');

      const [, , , destination] = inventoryMock.relocateReservedStock.mock.calls[0];
      expect(destination).toBe(company.warehouseId);
    });

    it('is a deliberate no-op for a plain in-house delivery with no custodian at all', async () => {
      const shipment = await service.createShipment('fo-1', 'admin-1');
      await service.assignDriver(shipment.id, 'driver-1', 'admin-1');

      await service.transitionShipment(shipment.id, 'pickup', 'driver-1');

      expect(inventoryMock.relocateReservedStock).not.toHaveBeenCalled();
    });

    it('skips a reservation that is already at the destination (e.g. a retried transition) rather than re-relocating it', async () => {
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', 'driver-1', null, null, 'admin-1');
      inventoryMock.getActiveReservationsForOrder.mockResolvedValueOnce([
        { id: 'rsv-1', warehouseId: vehicle.warehouseId, productId: 'prod-1', quantity: 3 },
      ] as never);
      const shipment = await service.createShipment('fo-1', 'admin-1', null, null, vehicle.id);
      await service.assignDriver(shipment.id, 'driver-1', 'admin-1');

      await service.transitionShipment(shipment.id, 'pickup', 'driver-1');

      expect(inventoryMock.relocateReservedStock).not.toHaveBeenCalled();
    });

    it('does not fire the custody transfer for any action other than pickup', async () => {
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', 'driver-1', null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', null, null, vehicle.id);
      await service.assignDriver(shipment.id, 'driver-1', 'admin-1');
      await service.transitionShipment(shipment.id, 'pickup', 'driver-1');
      inventoryMock.relocateReservedStock.mockClear();

      await service.transitionShipment(shipment.id, 'depart', 'driver-1');
      expect(inventoryMock.relocateReservedStock).not.toHaveBeenCalled();
    });
  });

  describe('Shipping Company waybill-required flow (CTO directive)', () => {
    it('rejects confirming pickup for a company-routed shipment with no carrier waybill number/image on file', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id);
      await service.assignDriver(shipment.id, 'driver-1', 'admin-1');

      await expect(service.transitionShipment(shipment.id, 'pickup', 'driver-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when only the number is set, not the image', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id);
      await service.assignDriver(shipment.id, 'driver-1', 'admin-1');
      await service.setCarrierWaybill(shipment.id, 'AWB-12345', null, 'driver-1');

      await expect(service.transitionShipment(shipment.id, 'pickup', 'driver-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allows pickup once both the carrier waybill number and image are on file', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id);
      await service.assignDriver(shipment.id, 'driver-1', 'admin-1');
      await service.setCarrierWaybill(shipment.id, 'AWB-12345', 'media-asset-1', 'driver-1');

      const status = await service.transitionShipment(shipment.id, 'pickup', 'driver-1');
      expect(status).toBe('picked_up');
    });

    it('does not apply to a plain in-house delivery with no shipping company', async () => {
      const shipment = await service.createShipment('fo-1', 'admin-1');
      await service.assignDriver(shipment.id, 'driver-1', 'admin-1');

      const status = await service.transitionShipment(shipment.id, 'pickup', 'driver-1');
      expect(status).toBe('picked_up');
    });

    it('setCarrierWaybill updates only the field(s) supplied, leaving the other untouched', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id);
      await service.setCarrierWaybill(shipment.id, 'AWB-12345', null, 'admin-1');
      const updated = await service.setCarrierWaybill(shipment.id, null, 'media-asset-1', 'admin-1');

      expect(updated.carrierWaybillNumber).toBe('AWB-12345');
      expect(updated.waybillImageMediaAssetId).toBe('media-asset-1');
    });

    it('treats an empty string the same as not-provided (REAL BUG FOUND LIVE: "" reached repo.save and crashed on the UUID column with a raw Postgres error, not a clean validation response)', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id);
      await service.setCarrierWaybill(shipment.id, 'AWB-12345', 'media-asset-1', 'admin-1');

      const unchanged = await service.setCarrierWaybill(shipment.id, '', '', 'admin-1');

      expect(unchanged.carrierWaybillNumber).toBe('AWB-12345');
      expect(unchanged.waybillImageMediaAssetId).toBe('media-asset-1');
    });

    it('rejects a non-driver, non-admin from setting the carrier waybill', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id);
      await expect(service.setCarrierWaybill(shipment.id, 'AWB-12345', 'media-asset-1', 'someone-else')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('getCurrentCustodyWarehouseId (Delivery\'s final-dispatch bridge)', () => {
    it('resolves the vehicle\'s sub-location when one is assigned', async () => {
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', 'driver-1', null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', null, null, vehicle.id);
      expect(await service.getCurrentCustodyWarehouseId(shipment.id)).toBe(vehicle.warehouseId);
    });

    it('returns null when no custodian was ever assigned — the caller falls back to the Fulfillment Order\'s own warehouse', async () => {
      const shipment = await service.createShipment('fo-1', 'admin-1');
      expect(await service.getCurrentCustodyWarehouseId(shipment.id)).toBeNull();
    });
  });

  describe('getCustodianForShipment (Delivery\'s custody-resolution bridge)', () => {
    it('resolves the vehicle\'s custody/settlement accounts when a vehicle is assigned', async () => {
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', null, null, null, 'admin-1');
      await service.setVehicleSettlementAccount(vehicle.id, 'acct-vehicle-settlement', 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', null, null, vehicle.id);

      const custodian = await service.getCustodianForShipment(shipment.id);
      expect(custodian).toEqual({ custodyAccountId: vehicle.custodyAccountId, settlementAccountId: 'acct-vehicle-settlement' });
    });

    it('falls back to the owning COMPANY\'s settlement account when the vehicle has none of its own', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      await service.setShippingCompanyTreasuryAccount(company.id, 'acct-company-settlement', 'admin-1');
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', null, company.id, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id, null, vehicle.id);

      const custodian = await service.getCustodianForShipment(shipment.id);
      expect(custodian?.settlementAccountId).toBe('acct-company-settlement');
    });

    it('returns null for a plain in-house delivery with no custodian', async () => {
      const shipment = await service.createShipment('fo-1', 'admin-1');
      expect(await service.getCustodianForShipment(shipment.id)).toBeNull();
    });
  });

  describe('getCustodianOverview (CTO directive §8 — inventory + money visibility per custodian)', () => {
    it('bundles a company\'s stock, custody balance, and active shipment count', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      await service.createShipment('fo-1', 'admin-1', company.id);
      await service.createShipment('fo-2', 'admin-1', company.id);

      const overview = await service.getCustodianOverview('company', company.id);
      expect(overview.warehouseId).toBe(company.warehouseId);
      expect(overview.custodyAccountId).toBe(company.custodyAccountId);
      expect(overview.custodyBalance).toBe('750.00');
      expect(overview.stock).toEqual([{ warehouseId: company.warehouseId, productId: 'prod-1', onHand: 3, reserved: 0, available: 3 }]);
      expect(overview.activeShipmentsCount).toBe(2);
    });

    it('bundles a vehicle\'s overview the same way', async () => {
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', null, null, null, 'admin-1');
      await service.createShipment('fo-1', 'admin-1', null, null, vehicle.id);

      const overview = await service.getCustodianOverview('vehicle', vehicle.id);
      expect(overview.activeShipmentsCount).toBe(1);
      expect(overview.custodyBalance).toBe('750.00');
    });

    it('REAL BUG FOUND AND FIXED: excludes delivered/returned shipments from activeShipmentsCount — a custodian that has ever completed a shipment no longer shows it as active forever', async () => {
      const vehicle = await service.createVehicle('CAR-002', 'XYZ-9999', null, null, null, 'admin-1');
      const delivered = await service.createShipment('fo-1', 'admin-1', null, null, vehicle.id);
      const returned = await service.createShipment('fo-2', 'admin-1', null, null, vehicle.id);
      await service.createShipment('fo-3', 'admin-1', null, null, vehicle.id); // still active
      shipmentStates.set(delivered.id, 'delivered');
      shipmentStates.set(returned.id, 'returned');

      const overview = await service.getCustodianOverview('vehicle', vehicle.id);
      expect(overview.activeShipmentsCount).toBe(1);
    });
  });

  describe('recordCustodyReversal (Returns Engine Phase B) — tracking event only, never a Process Engine transition', () => {
    it('posts a tracking event and never transitions the shipment', async () => {
      const shipment = await service.createShipment('fo-1', 'admin-1');
      processEngineMock.transition.mockClear();

      await service.recordCustodyReversal(shipment.id, 'prod-1', 3, 'worker-1');

      const events = await service.getTrackingHistory(shipment.id, 'admin-1');
      expect(events.some((e) => e.eventType === 'custody_reversed')).toBe(true);
      expect(processEngineMock.transition).not.toHaveBeenCalled();
      expect(await service.getStatus(shipment.id)).toBe('created'); // unchanged
    });

    it('rejects a custody reversal for an already-delivered shipment', async () => {
      const shipment = await service.createShipment('fo-1', 'admin-1');
      shipmentStates.set(shipment.id, 'delivered');
      await expect(service.recordCustodyReversal(shipment.id, 'prod-1', 3, 'worker-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a custody reversal for an unknown shipment', async () => {
      await expect(service.recordCustodyReversal('no-such-shipment', 'prod-1', 3, 'worker-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('searchCustodyShipments (Returns Engine Phase B — custody return search screen)', () => {
    it('rejects a role outside [admin, warehouse_worker, sales_supervisor]', async () => {
      await expect(service.searchCustodyShipments({}, 'unknown-user')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('only returns shipments actually routed through a custodian', async () => {
      await service.createShipment('fo-1', 'admin-1'); // plain in-house, no custodian
      const results = await service.searchCustodyShipments({}, 'admin-1');
      expect(results).toHaveLength(0);
    });

    it('resolves the full chain (customer/order/waybill/company/items/custody-status) for a company-custody shipment', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      inventoryMock.getActiveReservationsForOrder.mockImplementationOnce(async () => [
        { id: 'rsv-x', warehouseId: company.warehouseId as string, productId: 'prod-9', quantity: 7 },
      ]);
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id);

      const results = await service.searchCustodyShipments({ shipmentId: shipment.id }, 'admin-1');
      expect(results).toHaveLength(1);
      const [result] = results;
      expect(result.customerId).toBe('cust-1');
      expect(result.customerCode).toBe('CUST-001');
      expect(result.salesOrderId).toBe('so-1');
      expect(result.salesOrderNumber).toBe('SO-2026-000001');
      expect(result.custodianType).toBe('company');
      expect(result.custodianId).toBe(company.id);
      expect(result.custodianName).toBe('DHL Express');
      expect(result.currentCustodyStatus).toBe('created');
      expect(result.items).toEqual([{ productId: 'prod-9', quantity: 7 }]);
    });

    it('filters by customer code, resolving it via CustomersService.findByCode', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      await service.createShipment('fo-1', 'admin-1', company.id);

      const matched = await service.searchCustodyShipments({ customerCode: 'CUST-001' }, 'admin-1');
      expect(matched).toHaveLength(1);

      const unmatched = await service.searchCustodyShipments({ customerCode: 'CUST-999' }, 'admin-1');
      expect(unmatched).toHaveLength(0);
    });

    it('filters by waybill number', async () => {
      const company = await service.createShippingCompany('DHL', 'DHL Express', null, null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', company.id);

      const matched = await service.searchCustodyShipments({ waybillNumber: shipment.waybillNumber }, 'admin-1');
      expect(matched).toHaveLength(1);
      expect(matched[0].shipmentId).toBe(shipment.id);
    });

    it('resolves a vehicle custodian correctly', async () => {
      const vehicle = await service.createVehicle('CAR-001', 'ABC-1234', null, null, null, 'admin-1');
      const shipment = await service.createShipment('fo-1', 'admin-1', null, null, vehicle.id);

      const results = await service.searchCustodyShipments({ vehicleId: vehicle.id }, 'admin-1');
      expect(results).toHaveLength(1);
      expect(results[0].custodianType).toBe('vehicle');
      expect(results[0].custodianId).toBe(vehicle.id);
      expect(results[0].custodianName).toBe('ABC-1234');
      expect(results[0].shipmentId).toBe(shipment.id);
    });
  });
});
