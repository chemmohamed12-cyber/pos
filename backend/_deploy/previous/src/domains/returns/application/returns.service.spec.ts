import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ReturnsService } from './returns.service';
import { ReturnRequest } from '../infrastructure/return-request.entity';
import { ReturnDisposition } from '../infrastructure/return-disposition.entity';
import { ReturnCredit } from '../infrastructure/return-credit.entity';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { DeliveryService } from '../../delivery/application/delivery.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { InvoiceService } from '../../customer-finance/application/invoices.service';
import { CustomersService } from '../../crm/application/customers.service';

const WH = 'wh-1'; // the order's own (Finished Goods) warehouse for every test fixture below

/**
 * Proves ADR-008's reusability claim a fourth time (Returns reuses the
 * same Process Engine), blueprint §29's key invariant: restock only
 * happens on an actual disposition, never merely on warehouse receipt —
 * a damaged item must never silently become sellable stock. Also proves
 * the Returns Engine directive's own additions: real Inspection-location
 * ledger presence, the sold-minus-previously-returned quantity cap, and
 * Return Credit issuance/application.
 */
describe('ReturnsService', () => {
  let service: ReturnsService;
  const requests = new Map<string, ReturnRequest>();
  const dispositions: ReturnDisposition[] = [];
  const credits = new Map<string, ReturnCredit>();
  const requestStates = new Map<string, string>();
  const publishedTopics: string[] = [];
  const subLocations = new Map<string, { id: string; parentWarehouseId: string; code: string }>();
  let idSeq = 0;

  const requestRepo = {
    create: jest.fn((d: Partial<ReturnRequest>) => ({ id: `ret-${++idSeq}`, ...d }) as ReturnRequest),
    save: jest.fn(async (r: ReturnRequest) => {
      requests.set(r.id, r);
      return r;
    }),
    findOneOrFail: jest.fn(async ({ where }: { where: { id: string } }) => requests.get(where.id)!),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => requests.get(where.id) ?? null),
    find: jest.fn(async ({ where }: { where?: { salesOrderLineId?: string } }) => {
      const all = [...requests.values()];
      if (where?.salesOrderLineId) return all.filter((r) => r.salesOrderLineId === where.salesOrderLineId);
      return all;
    }),
  };
  const dispositionRepo = {
    create: jest.fn((d: Partial<ReturnDisposition>) => ({ id: `disp-${dispositions.length + 1}`, ...d }) as ReturnDisposition),
    save: jest.fn(async (d: ReturnDisposition) => {
      dispositions.push(d);
      return d;
    }),
  };
  const creditRepo = {
    create: jest.fn((d: Partial<ReturnCredit>) => ({ id: `credit-${++idSeq}`, ...d }) as ReturnCredit),
    save: jest.fn(async (c: ReturnCredit) => {
      credits.set(c.id, c);
      return c;
    }),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => credits.get(where.id) ?? null),
    createQueryBuilder: jest.fn(() => {
      let allowedCustomerIds: string[] | undefined;
      const qb: {
        where: (cond: string, params: { customerId?: string; customerIds?: string[] }) => typeof qb;
        andWhere: (cond: string) => typeof qb;
        orderBy: (col: string, dir?: string) => typeof qb;
        getMany: () => Promise<ReturnCredit[]>;
      } = {
        where: (_cond, params) => {
          allowedCustomerIds = params.customerIds ?? (params.customerId ? [params.customerId] : undefined);
          return qb;
        },
        andWhere: () => qb,
        orderBy: () => qb,
        getMany: async () => [...credits.values()].filter((c) => (allowedCustomerIds ?? []).includes(c.customerId) && Number(c.remainingAmount) > 0),
      };
      return qb;
    }),
  };

  const getRepositoryMock = jest.fn((entity: unknown) => {
    if (entity === ReturnRequest) return requestRepo;
    if (entity === ReturnCredit) return creditRepo;
    return dispositionRepo;
  });
  const dataSourceMock = {
    getRepository: getRepositoryMock,
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn({ getRepository: getRepositoryMock })),
  };

  const processEngineMock = {
    start: jest.fn(async (_d: unknown, _t: string, id: string) => requestStates.set(id, 'requested')),
    transition: jest.fn(async (_d: unknown, _t: string, id: string, action: string) => {
      const map: Record<string, string> = {
        authorize: 'authorized',
        reject: 'rejected',
        receive_at_warehouse: 'received',
        inspect: 'inspected',
        disposition: 'dispositioned',
      };
      requestStates.set(id, map[action]);
    }),
    getState: jest.fn(async (_d: unknown, _t: string, id: string) => requestStates.get(id) ?? 'requested'),
  };
  const authorizationMock = {
    getRoleKeysForUser: jest.fn(async (userId: string) => {
      if (userId === 'supervisor-1') return ['sales_supervisor'];
      if (userId === 'worker-1') return ['warehouse_worker'];
      if (userId === 'admin-1') return ['admin'];
      return [];
    }),
  };
  const auditMock = { record: jest.fn(async () => undefined) };
  const eventsMock = {
    publish: jest.fn(async (_m: unknown, topic: string) => {
      publishedTopics.push(topic);
    }),
  };
  // Reservations fixture — backs `relocateReservedStock`/`releaseReservedQuantity`
  // mocks the same way real InventoryService does (drain active rows,
  // extend/create a destination row), so Phase B custody-return tests can
  // assert real "insufficient custody quantity" / partial-release behavior.
  type MockReservation = { id: string; salesOrderId: string; productId: string; warehouseId: string; quantity: number; status: 'active' | 'released' };
  const reservations = new Map<string, MockReservation>();
  let reservationSeq = 0;
  function seedReservation(salesOrderId: string, productId: string, warehouseId: string, quantity: number): void {
    const id = `res-${++reservationSeq}`;
    reservations.set(id, { id, salesOrderId, productId, warehouseId, quantity, status: 'active' });
  }

  const inventoryMock = {
    recordMovement: jest.fn(
      async (_warehouseId: string, _productId: string, _quantity: number, _movementType: string, _refType: string | null, _refId: string | null, _actorUserId: string | null) =>
        ({ id: 'mv-1' }),
    ),
    findOperationalSubLocation: jest.fn(async (parentWarehouseId: string, codePrefix: string) => {
      const found = [...subLocations.values()].find((w) => w.parentWarehouseId === parentWarehouseId && w.code.startsWith(codePrefix));
      return found ? { id: found.id, code: found.code } : null;
    }),
    createWarehouse: jest.fn(async (code: string, _name: string, _loc: unknown, _resp: unknown, parentWarehouseId: string) => {
      const wh = { id: `sub-${subLocations.size + 1}`, parentWarehouseId, code };
      subLocations.set(wh.id, wh);
      return wh;
    }),
    relocateReservedStock: jest.fn(async (salesOrderId: string, productId: string, fromWarehouseId: string, toWarehouseId: string, quantity: number) => {
      const sourceRows = [...reservations.values()].filter(
        (r) => r.salesOrderId === salesOrderId && r.productId === productId && r.warehouseId === fromWarehouseId && r.status === 'active',
      );
      const totalActive = sourceRows.reduce((sum, r) => sum + r.quantity, 0);
      if (totalActive < quantity) {
        throw new ConflictException(`Cannot relocate ${quantity} — only ${totalActive} actively reserved at "${fromWarehouseId}".`);
      }
      let remaining = quantity;
      for (const row of sourceRows) {
        if (remaining <= 0) break;
        const take = Math.min(row.quantity, remaining);
        row.quantity -= take;
        remaining -= take;
        if (row.quantity === 0) row.status = 'released';
      }
      const destExisting = [...reservations.values()].find(
        (r) => r.salesOrderId === salesOrderId && r.productId === productId && r.warehouseId === toWarehouseId && r.status === 'active',
      );
      if (destExisting) {
        destExisting.quantity += quantity;
      } else {
        seedReservation(salesOrderId, productId, toWarehouseId, quantity);
      }
    }),
    releaseReservedQuantity: jest.fn(async (salesOrderId: string, productId: string, warehouseId: string, quantity: number) => {
      const rows = [...reservations.values()].filter(
        (r) => r.salesOrderId === salesOrderId && r.productId === productId && r.warehouseId === warehouseId && r.status === 'active',
      );
      const totalActive = rows.reduce((sum, r) => sum + r.quantity, 0);
      if (totalActive < quantity) {
        throw new ConflictException(`Cannot release ${quantity} — only ${totalActive} actively reserved at "${warehouseId}".`);
      }
      let remaining = quantity;
      for (const row of rows) {
        if (remaining <= 0) break;
        const take = Math.min(row.quantity, remaining);
        row.quantity -= take;
        remaining -= take;
        if (row.quantity === 0) row.status = 'released';
      }
    }),
  };

  function activeReservationQuantity(salesOrderId: string, productId: string, warehouseId: string): number {
    return [...reservations.values()]
      .filter((r) => r.salesOrderId === salesOrderId && r.productId === productId && r.warehouseId === warehouseId && r.status === 'active')
      .reduce((sum, r) => sum + r.quantity, 0);
  }

  const shipmentStates = new Map<string, string>([
    ['ship-company-1', 'in_transit'],
    ['ship-vehicle-1', 'in_transit'],
    ['ship-delivered-1', 'delivered'],
    ['ship-no-custodian-1', 'in_transit'],
    ['ship-collected-1', 'in_transit'],
  ]);
  const shipmentSnapshots = new Map<
    string,
    { id: string; fulfillmentOrderId: string; shippingCompanyId: string | null; vehicleId: string | null; codAmount: string | null; salesOrderId: string | null }
  >([
    ['ship-company-1', { id: 'ship-company-1', fulfillmentOrderId: 'ful-1', shippingCompanyId: 'company-1', vehicleId: null, codAmount: null, salesOrderId: 'so-1' }],
    ['ship-vehicle-1', { id: 'ship-vehicle-1', fulfillmentOrderId: 'ful-2', shippingCompanyId: null, vehicleId: 'vehicle-1', codAmount: null, salesOrderId: 'so-2' }],
    ['ship-delivered-1', { id: 'ship-delivered-1', fulfillmentOrderId: 'ful-3', shippingCompanyId: 'company-1', vehicleId: null, codAmount: null, salesOrderId: 'so-1' }],
    ['ship-no-custodian-1', { id: 'ship-no-custodian-1', fulfillmentOrderId: 'ful-4', shippingCompanyId: null, vehicleId: null, codAmount: null, salesOrderId: 'so-1' }],
    ['ship-collected-1', { id: 'ship-collected-1', fulfillmentOrderId: 'ful-5', shippingCompanyId: 'company-1', vehicleId: null, codAmount: '100.00', salesOrderId: 'so-1' }],
  ]);
  const custodyWarehouses = new Map<string, string | null>([
    ['ship-company-1', 'company-wh-1'],
    ['ship-vehicle-1', 'vehicle-wh-1'],
    ['ship-delivered-1', 'company-wh-1'],
    ['ship-no-custodian-1', null],
    ['ship-collected-1', 'company-wh-1'],
  ]);
  const collections = new Map<string, { id: string } | undefined>([['ship-collected-1', { id: 'coll-1' }]]);
  const custodyReversals: Array<{ shipmentId: string; productId: string; quantity: number }> = [];

  const shipmentsMock = {
    getStatus: jest.fn(async (id: string) => shipmentStates.get(id) ?? 'created'),
    getShipmentSnapshot: jest.fn(async (id: string) => shipmentSnapshots.get(id) ?? null),
    getCurrentCustodyWarehouseId: jest.fn(async (id: string) => custodyWarehouses.get(id) ?? null),
    recordCustodyReversal: jest.fn(async (shipmentId: string, productId: string, quantity: number) => {
      custodyReversals.push({ shipmentId, productId, quantity });
    }),
  };
  const deliveryMock = {
    getCollectionForShipmentUnscoped: jest.fn(async (shipmentId: string) => collections.get(shipmentId) ?? null),
  };
  const customersMock = {
    listCustomers: jest.fn(async () => [
      { id: 'cust-1', code: 'CUST-001', name: 'Customer One' },
      { id: 'cust-2', code: 'CUST-002', name: 'Customer Two' },
    ]),
  };

  const invoiceFixtures = new Map<string, { id: string; customerId: string; salesOrderId: string; state: string }>([
    ['inv-posted-1', { id: 'inv-posted-1', customerId: 'cust-1', salesOrderId: 'so-1', state: 'posted' }],
    ['inv-draft-1', { id: 'inv-draft-1', customerId: 'cust-1', salesOrderId: 'so-1', state: 'draft' }],
  ]);
  const postedLedgerEntries: Array<Record<string, unknown>> = [];
  const customerLedgerMock = {
    postEntry: jest.fn(async (input: Record<string, unknown>) => {
      postedLedgerEntries.push(input);
      return { id: `cle-${postedLedgerEntries.length}`, ...input };
    }),
  };
  const invoicesMock = {
    getInvoice: jest.fn(async (invoiceId: string) => {
      const inv = invoiceFixtures.get(invoiceId);
      if (!inv) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
      return inv;
    }),
    recomputeStatus: jest.fn(async () => 'partially_paid'),
  };
  const registeredPrefixes = new Map<string, string>();
  const documentCounters = new Map<string, number>();
  const numberingMock = {
    registerDocumentType: jest.fn(async (documentType: string, prefix: string) => {
      if (!registeredPrefixes.has(documentType)) registeredPrefixes.set(documentType, prefix);
    }),
    getNextNumber: jest.fn(async (documentType: string) => {
      const prefix = registeredPrefixes.get(documentType) ?? documentType.toUpperCase().slice(0, 6);
      const next = (documentCounters.get(documentType) ?? 0) + 1;
      documentCounters.set(documentType, next);
      if (documentType === 'return') return `${prefix}-2026-${String(next).padStart(6, '0')}`;
      return `${prefix}-${String(next).padStart(6, '0')}`;
    }),
  };
  const orderLines = new Map<string, { id: string; salesOrderId: string; productId: string; quantity: number; unitPrice: string; discountAmount: string; lineTotal: string }>([
    ['line-1', { id: 'line-1', salesOrderId: 'so-1', productId: 'prod-1', quantity: 5, unitPrice: '20.00', discountAmount: '0', lineTotal: '100.00' }],
    ['line-discounted', { id: 'line-discounted', salesOrderId: 'so-2', productId: 'prod-2', quantity: 4, unitPrice: '25.00', discountAmount: '20.00', lineTotal: '80.00' }],
  ]);
  const orders = new Map<string, { id: string; customerId: string; warehouseId: string }>([
    ['so-1', { id: 'so-1', customerId: 'cust-1', warehouseId: WH }],
    ['so-2', { id: 'so-2', customerId: 'cust-1', warehouseId: WH }],
    ['so-draft', { id: 'so-draft', customerId: 'cust-1', warehouseId: WH }],
    ['so-other-customer', { id: 'so-other-customer', customerId: 'cust-2', warehouseId: WH }],
  ]);
  const orderStatuses = new Map<string, string>([
    ['so-1', 'released'],
    ['so-2', 'released'],
    ['so-draft', 'draft'],
    ['so-other-customer', 'draft'],
  ]);
  const salesOrdersMock = {
    getOrderLineById: jest.fn(async (lineId: string) => orderLines.get(lineId) ?? null),
    getOrder: jest.fn(async (orderId: string) => orders.get(orderId) ?? null),
    getOrderSnapshot: jest.fn(async (orderId: string) => orders.get(orderId) ?? null),
    getOrderStatus: jest.fn(async (orderId: string) => orderStatuses.get(orderId) ?? 'draft'),
  };

  beforeEach(async () => {
    requests.clear();
    dispositions.length = 0;
    credits.clear();
    requestStates.clear();
    publishedTopics.length = 0;
    subLocations.clear();
    registeredPrefixes.clear();
    documentCounters.clear();
    idSeq = 0;
    reservations.clear();
    reservationSeq = 0;
    custodyReversals.length = 0;
    postedLedgerEntries.length = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: ProcessEngineService, useValue: processEngineMock },
        { provide: AuthorizationService, useValue: authorizationMock },
        { provide: AuditService, useValue: auditMock },
        { provide: EventBusService, useValue: eventsMock },
        { provide: InventoryService, useValue: inventoryMock },
        { provide: NumberingService, useValue: numberingMock },
        { provide: SalesOrdersService, useValue: salesOrdersMock },
        { provide: ShipmentService, useValue: shipmentsMock },
        { provide: DeliveryService, useValue: deliveryMock },
        { provide: CustomerLedgerService, useValue: customerLedgerMock },
        { provide: InvoiceService, useValue: invoicesMock },
        { provide: CustomersService, useValue: customersMock },
      ],
    }).compile();
    service = moduleRef.get(ReturnsService);
  });

  async function walkToInspected(lineId = 'line-1', quantity = 3, returnType: 'exchange' | 'value_credit' | 'product_return' = 'product_return') {
    const request = await service.createReturnRequest(lineId, quantity, returnType, 'Wrong item shipped', 'rep-1');
    await service.authorize(request.id, 'supervisor-1');
    await service.receiveAtWarehouse(request.id, 'worker-1');
    await service.inspect(request.id, 'worker-1');
    return request.id;
  }

  it('creates a return request started at "requested", resolving productId/warehouseId from the line and order (never trusted from the client)', async () => {
    const request = await service.createReturnRequest('line-1', 3, 'product_return', 'Damaged', 'rep-1');
    expect(await service.getStatus(request.id)).toBe('requested');
    expect(request.productId).toBe('prod-1');
    expect(request.warehouseId).toBe(WH);
    expect(request.returnNumber).toMatch(/^RET-2026-/);
  });

  it('rejects an invalid return type', async () => {
    await expect(service.createReturnRequest('line-1', 1, 'bogus' as any, 'Damaged', 'rep-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects authorization by a non-supervisor', async () => {
    const request = await service.createReturnRequest('line-1', 3, 'product_return', 'Damaged', 'rep-1');
    await expect(service.authorize(request.id, 'rep-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('quantity cap (CTO directive §2 — returned qty <= sold qty - previously returned qty)', () => {
    it('rejects a return exceeding the line\'s own sold quantity', async () => {
      await expect(service.createReturnRequest('line-1', 6, 'product_return', 'Too many', 'rep-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('accounts for a prior non-rejected return against the SAME line when capping a second one', async () => {
      await service.createReturnRequest('line-1', 3, 'product_return', 'First return', 'rep-1'); // 3 of 5 already in-flight
      await expect(service.createReturnRequest('line-1', 3, 'product_return', 'Second return', 'rep-1')).rejects.toBeInstanceOf(ConflictException);
      await expect(service.createReturnRequest('line-1', 2, 'product_return', 'Second return', 'rep-1')).resolves.toBeDefined(); // exactly the remainder
    });

    it('does NOT count a REJECTED prior return against the cap', async () => {
      const first = await service.createReturnRequest('line-1', 5, 'product_return', 'First return', 'rep-1'); // all 5
      await service.reject(first.id, 'supervisor-1');
      await expect(service.createReturnRequest('line-1', 5, 'product_return', 'Retry', 'rep-1')).resolves.toBeDefined(); // full 5 available again
    });
  });

  describe('Returns/Inspection Location (CTO directive — real ledger presence, not just a status flip)', () => {
    it('receiveAtWarehouse posts a real return_in movement into an auto-provisioned Inspection sub-location', async () => {
      const request = await service.createReturnRequest('line-1', 3, 'product_return', 'Damaged', 'rep-1');
      await service.authorize(request.id, 'supervisor-1');
      inventoryMock.recordMovement.mockClear();

      await service.receiveAtWarehouse(request.id, 'worker-1');

      expect(inventoryMock.recordMovement).toHaveBeenCalledWith(
        expect.stringMatching(/^sub-/),
        'prod-1',
        3,
        'return_in',
        'return_request',
        request.id,
        'worker-1',
      );
    });

    it('reuses the SAME Inspection sub-location across multiple returns for the same warehouse (get-or-create, not create-every-time)', async () => {
      const r1 = await service.createReturnRequest('line-1', 1, 'product_return', 'A', 'rep-1');
      await service.authorize(r1.id, 'supervisor-1');
      await service.receiveAtWarehouse(r1.id, 'worker-1');
      const firstCallArgs = inventoryMock.recordMovement.mock.calls[0];
      const inspectionId = firstCallArgs[0];

      const r2 = await service.createReturnRequest('line-1', 1, 'product_return', 'B', 'rep-1');
      await service.authorize(r2.id, 'supervisor-1');
      await service.receiveAtWarehouse(r2.id, 'worker-1');
      const secondCallArgs = inventoryMock.recordMovement.mock.calls[inventoryMock.recordMovement.mock.calls.length - 1];
      expect(secondCallArgs[0]).toBe(inspectionId);
      expect(inventoryMock.createWarehouse).toHaveBeenCalledTimes(1); // only provisioned once
    });
  });

  describe('recordDisposition (CTO directive — every disposition now moves stock OUT of Inspection to a real destination)', () => {
    it('restock: moves stock out of Inspection and into the order\'s own (Finished Goods) warehouse', async () => {
      const requestId = await walkToInspected();
      inventoryMock.recordMovement.mockClear();
      await service.recordDisposition(requestId, 'restock', null, 'worker-1');
      const calls = inventoryMock.recordMovement.mock.calls;
      expect(calls.find((c) => c[3] === 'transfer_out')).toBeTruthy();
      expect(calls.find((c) => c[3] === 'transfer_in' && c[0] === WH)).toBeTruthy();
    });

    it('damaged: moves stock out of Inspection into a Damaged sub-location, never back into Finished Goods', async () => {
      const requestId = await walkToInspected();
      inventoryMock.recordMovement.mockClear();
      await service.recordDisposition(requestId, 'damaged', 'Cracked casing', 'worker-1');
      const calls = inventoryMock.recordMovement.mock.calls;
      const inLeg = calls.find((c) => c[3] === 'transfer_in');
      expect(inLeg).toBeTruthy();
      expect(inLeg![0]).not.toBe(WH); // a real, distinct Damaged location, not Finished Goods
      expect(publishedTopics).toContain('return.completed');
    });

    it('scrap: debits Inspection only — a genuine write-off, no inbound leg', async () => {
      const requestId = await walkToInspected();
      inventoryMock.recordMovement.mockClear();
      await service.recordDisposition(requestId, 'scrap', null, 'worker-1');
      const calls = inventoryMock.recordMovement.mock.calls;
      expect(calls.filter((c) => c[3] === 'transfer_out')).toHaveLength(1);
      expect(calls.filter((c) => c[3] === 'transfer_in')).toHaveLength(0);
    });

    it('rejects recording a disposition before inspection has occurred', async () => {
      const request = await service.createReturnRequest('line-1', 3, 'product_return', 'Damaged', 'rep-1');
      await service.authorize(request.id, 'supervisor-1');
      // skipped receive_at_warehouse and inspect
      await expect(service.recordDisposition(request.id, 'restock', null, 'worker-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('walks the full lifecycle end-to-end: requested -> authorized -> received -> inspected -> dispositioned', async () => {
      const requestId = await walkToInspected(undefined, undefined, 'exchange');
      expect(await service.getStatus(requestId)).toBe('inspected');
      await service.recordDisposition(requestId, 'replacement', null, 'worker-1');
      expect(await service.getStatus(requestId)).toBe('dispositioned');
    });
  });

  describe('Return Credit issuance (CTO directive §2 — value_credit and product_return only, never exchange)', () => {
    it('creates a ReturnCredit for a product_return, priced from the line\'s own historical price (never the product\'s current price)', async () => {
      const requestId = await walkToInspected('line-1', 3, 'product_return'); // line-1: unitPrice 20.00, no discount, lineTotal 100.00 for qty 5 -> 20.00/unit
      await service.recordDisposition(requestId, 'restock', null, 'worker-1');

      const available = await service.listAvailableCredits('cust-1');
      const created = available.find((c) => c.returnRequestId === requestId);
      expect(created).toBeDefined();
      expect(created!.originalAmount).toBe('60.00'); // 20.00/unit * 3
      expect(created!.remainingAmount).toBe('60.00');
      expect(created!.status).toBe('active');
    });

    it('prices a partial return of a DISCOUNTED line proportionally, from lineTotal, not the raw unitPrice', async () => {
      // line-discounted: unitPrice 25.00, discount 20.00 off qty 4 -> lineTotal 80.00 -> effective 20.00/unit
      const request = await service.createReturnRequest('line-discounted', 2, 'value_credit', 'Return 2', 'rep-1');
      await service.authorize(request.id, 'supervisor-1');
      await service.receiveAtWarehouse(request.id, 'worker-1');
      await service.inspect(request.id, 'worker-1');
      await service.recordDisposition(request.id, 'restock', null, 'worker-1');

      const available = await service.listAvailableCredits('cust-1');
      const created = available.find((c) => c.returnRequestId === request.id);
      expect(created!.originalAmount).toBe('40.00'); // 20.00 effective/unit * 2, NOT 25.00*2=50.00
    });

    it('does NOT create a ReturnCredit for an exchange', async () => {
      const requestId = await walkToInspected('line-1', 1, 'exchange');
      await service.recordDisposition(requestId, 'replacement', null, 'worker-1');
      const available = await service.listAvailableCredits('cust-1');
      expect(available.find((c) => c.returnRequestId === requestId)).toBeUndefined();
    });

    it('listAvailableCredits excludes credits with zero remaining balance', async () => {
      const requestId = await walkToInspected('line-1', 1, 'product_return');
      await service.recordDisposition(requestId, 'restock', null, 'worker-1');
      const [credit] = await service.listAvailableCredits('cust-1');
      await service.applyCreditToOrder(credit.id, 'so-draft', credit.remainingAmount, 'rep-1');
      const afterFullyUsed = await service.listAvailableCredits('cust-1');
      expect(afterFullyUsed.find((c) => c.id === credit.id)).toBeUndefined();
    });
  });

  describe('applyCreditToOrder (CTO directive §6/§7 — one order at a time, own customer only, draft only, never re-used past its balance)', () => {
    async function issueCredit(): Promise<{ id: string; remainingAmount: string }> {
      const requestId = await walkToInspected('line-1', 2, 'product_return'); // 20.00/unit * 2 = 40.00
      await service.recordDisposition(requestId, 'restock', null, 'worker-1');
      const [credit] = await service.listAvailableCredits('cust-1');
      return credit;
    }

    it('applies a partial amount, decrementing remainingAmount and staying active', async () => {
      const credit = await issueCredit();
      const updated = await service.applyCreditToOrder(credit.id, 'so-draft', '15.00', 'rep-1');
      expect(updated.usedAmount).toBe('15.00');
      expect(updated.remainingAmount).toBe('25.00');
      expect(updated.status).toBe('active');
      expect(updated.appliedToSalesOrderId).toBe('so-draft');
    });

    it('marks the credit fully_used once the full remaining amount is applied', async () => {
      const credit = await issueCredit();
      const updated = await service.applyCreditToOrder(credit.id, 'so-draft', '40.00', 'rep-1');
      expect(updated.status).toBe('fully_used');
      expect(updated.remainingAmount).toBe('0.00');
    });

    it('rejects applying more than the remaining balance', async () => {
      const credit = await issueCredit();
      await expect(service.applyCreditToOrder(credit.id, 'so-draft', '999.00', 'rep-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects applying a credit to an order belonging to a DIFFERENT customer', async () => {
      const credit = await issueCredit();
      await expect(service.applyCreditToOrder(credit.id, 'so-other-customer', '10.00', 'rep-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects applying a credit to a non-draft order', async () => {
      const credit = await issueCredit();
      await expect(service.applyCreditToOrder(credit.id, 'so-1', '10.00', 'rep-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects applying a credit that no longer exists', async () => {
      await expect(service.applyCreditToOrder('no-such-credit', 'so-draft', '10.00', 'rep-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects re-applying an already fully_used credit', async () => {
      const credit = await issueCredit();
      await service.applyCreditToOrder(credit.id, 'so-draft', '40.00', 'rep-1');
      await expect(service.applyCreditToOrder(credit.id, 'so-draft', '1.00', 'rep-1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('applyCreditToInvoice (Customer Financial Account / AR — CTO directive §7, same guards as applyCreditToOrder via the shared helper)', () => {
    async function issueCreditForInvoiceTests(): Promise<{ id: string; remainingAmount: string }> {
      const requestId = await walkToInspected('line-1', 2, 'product_return'); // 20.00/unit * 2 = 40.00, customer cust-1, order so-1
      await service.recordDisposition(requestId, 'restock', null, 'worker-1');
      const [credit] = await service.listAvailableCredits('cust-1');
      return credit;
    }

    it('applies a partial amount to a POSTED invoice, posts a return_credit_note ledger credit, and recomputes the invoice status', async () => {
      const credit = await issueCreditForInvoiceTests();
      const updated = await service.applyCreditToInvoice(credit.id, 'inv-posted-1', '15.00', 'finance-1');

      expect(updated.usedAmount).toBe('15.00');
      expect(updated.remainingAmount).toBe('25.00');
      expect(updated.status).toBe('active');
      expect(updated.appliedToInvoiceId).toBe('inv-posted-1');
      expect(postedLedgerEntries).toHaveLength(1);
      expect(postedLedgerEntries[0]).toMatchObject({
        customerId: 'cust-1',
        entryType: 'return_credit_note',
        direction: 'credit',
        amount: '15.00',
        salesOrderId: 'so-1',
        invoiceId: 'inv-posted-1',
        returnCreditId: credit.id,
      });
      expect(invoicesMock.recomputeStatus).toHaveBeenCalledWith('inv-posted-1', 'finance-1');
    });

    it('rejects applying to a DRAFT invoice — only posted/partially_paid invoices carry real AR', async () => {
      const credit = await issueCreditForInvoiceTests();
      await expect(service.applyCreditToInvoice(credit.id, 'inv-draft-1', '10.00', 'finance-1')).rejects.toBeInstanceOf(ConflictException);
      expect(postedLedgerEntries).toHaveLength(0);
    });

    it('rejects applying more than the remaining balance (shared guard with applyCreditToOrder)', async () => {
      const credit = await issueCreditForInvoiceTests();
      await expect(service.applyCreditToInvoice(credit.id, 'inv-posted-1', '999.00', 'finance-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('never lets the SAME credit be double-spent across both an order and an invoice application', async () => {
      const credit = await issueCreditForInvoiceTests();
      await service.applyCreditToOrder(credit.id, 'so-draft', '40.00', 'finance-1'); // fully consumes it
      await expect(service.applyCreditToInvoice(credit.id, 'inv-posted-1', '1.00', 'finance-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects an unknown invoice id', async () => {
      const credit = await issueCreditForInvoiceTests();
      await expect(service.applyCreditToInvoice(credit.id, 'no-such-invoice', '10.00', 'finance-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('listAllAvailableCredits (ERP UI Integration — Scope-filtered across every visible customer)', () => {
      it('enriches each credit with its customer code/name, Scope-filtered via CustomersService.listCustomers', async () => {
        await issueCreditForInvoiceTests(); // issues a credit for cust-1
        const all = await service.listAllAvailableCredits('actor-1');
        expect(customersMock.listCustomers).toHaveBeenCalledWith('actor-1');
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ customerCode: 'CUST-001', customerName: 'Customer One' });
      });

      it('returns an empty array when the actor has no visible customers', async () => {
        await issueCreditForInvoiceTests();
        customersMock.listCustomers.mockResolvedValueOnce([]);
        const all = await service.listAllAvailableCredits('actor-2');
        expect(all).toEqual([]);
      });
    });
  });

  describe('Phase B — custody returns (Shipping Company / Company Vehicle custody, pre-delivery)', () => {
    describe('initiateCustodyReturn', () => {
      it('rejects a shipment with no shipping-company/vehicle custodian assigned', async () => {
        await expect(
          service.initiateCustodyReturn('ship-no-custodian-1', 'prod-1', 2, 'Wrong item loaded', 'worker-1'),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('rejects a shipment already delivered', async () => {
        seedReservation('so-1', 'prod-1', 'company-wh-1', 5);
        await expect(
          service.initiateCustodyReturn('ship-delivered-1', 'prod-1', 2, 'Too late', 'worker-1'),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('rejects a shipment that already has a COD collection recorded', async () => {
        seedReservation('so-1', 'prod-1', 'company-wh-1', 5);
        await expect(
          service.initiateCustodyReturn('ship-collected-1', 'prod-1', 2, 'Too late', 'worker-1'),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('rejects a role outside [warehouse_worker, sales_supervisor, admin]', async () => {
        seedReservation('so-1', 'prod-1', 'company-wh-1', 5);
        await expect(
          service.initiateCustodyReturn('ship-company-1', 'prod-1', 2, 'Wrong item loaded', 'rep-1'),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('rejects returning more than is actually in custody (real cap comes from relocateReservedStock)', async () => {
        seedReservation('so-1', 'prod-1', 'company-wh-1', 3);
        await expect(
          service.initiateCustodyReturn('ship-company-1', 'prod-1', 5, 'Over-return', 'worker-1'),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('happy path (Shipping Company custody): reaches "received", relocates the reservation into Inspection, records a custody reversal on the shipment', async () => {
        seedReservation('so-1', 'prod-1', 'company-wh-1', 5);
        const request = await service.initiateCustodyReturn('ship-company-1', 'prod-1', 3, 'Overstock at company', 'worker-1');

        expect(await service.getStatus(request.id)).toBe('received');
        expect(request.origin).toBe('shipping_company_custody');
        expect(request.custodianType).toBe('company');
        expect(request.custodianId).toBe('company-1');
        expect(request.shipmentId).toBe('ship-company-1');
        expect(request.returnType).toBeNull();
        expect(request.salesOrderLineId).toBeNull();

        // 3 of 5 relocated out of company custody into Inspection.
        expect(activeReservationQuantity('so-1', 'prod-1', 'company-wh-1')).toBe(2);
        const inspectionRow = [...reservations.values()].find(
          (r) => r.salesOrderId === 'so-1' && r.productId === 'prod-1' && r.warehouseId !== 'company-wh-1' && r.status === 'active',
        );
        expect(inspectionRow?.quantity).toBe(3);
        expect(custodyReversals).toEqual([{ shipmentId: 'ship-company-1', productId: 'prod-1', quantity: 3 }]);
      });

      it('happy path (Company Vehicle custody): resolves the vehicle as the custodian', async () => {
        seedReservation('so-2', 'prod-2', 'vehicle-wh-1', 4);
        const request = await service.initiateCustodyReturn('ship-vehicle-1', 'prod-2', 4, 'Vehicle breakdown — offloading', 'worker-1');

        expect(request.origin).toBe('vehicle_custody');
        expect(request.custodianType).toBe('vehicle');
        expect(request.custodianId).toBe('vehicle-1');
        expect(activeReservationQuantity('so-2', 'prod-2', 'vehicle-wh-1')).toBe(0); // fully relocated out
      });
    });

    describe('recordDisposition — custody-origin branching', () => {
      async function walkCustodyToInspected(shipmentId = 'ship-company-1', salesOrderId = 'so-1', productId = 'prod-1', quantity = 3) {
        seedReservation(salesOrderId, productId, 'company-wh-1', quantity);
        const request = await service.initiateCustodyReturn(shipmentId, productId, quantity, 'Custody return', 'worker-1');
        await service.inspect(request.id, 'worker-1');
        return request.id;
      }

      it('rejects "replacement" — meaningless for a pre-delivery custody return', async () => {
        const requestId = await walkCustodyToInspected();
        await expect(service.recordDisposition(requestId, 'replacement', null, 'worker-1')).rejects.toBeInstanceOf(BadRequestException);
      });

      it('restock: relocates the reservation itself back to Finished Goods, staying active/fulfillable', async () => {
        const requestId = await walkCustodyToInspected();
        await service.recordDisposition(requestId, 'restock', null, 'worker-1');
        expect(activeReservationQuantity('so-1', 'prod-1', WH)).toBe(3);
      });

      it('damaged: releases exactly the returned quantity of the reservation, creates zero ReturnCredit', async () => {
        const requestId = await walkCustodyToInspected();
        const before = credits.size;
        await service.recordDisposition(requestId, 'damaged', 'Crushed in transit', 'worker-1');
        // The reservation that was sitting at Inspection is now released, not moved anywhere active.
        expect([...reservations.values()].filter((r) => r.salesOrderId === 'so-1' && r.productId === 'prod-1' && r.status === 'active')).toHaveLength(0);
        expect(credits.size).toBe(before); // never issued for a custody-origin return
      });

      it('scrap: releases the reservation and posts a one-sided write-off (no inbound leg)', async () => {
        const requestId = await walkCustodyToInspected();
        inventoryMock.recordMovement.mockClear();
        await service.recordDisposition(requestId, 'scrap', 'Unsellable', 'worker-1');
        const calls = inventoryMock.recordMovement.mock.calls;
        expect(calls.filter((c) => c[3] === 'transfer_out')).toHaveLength(1);
        expect(calls.filter((c) => c[3] === 'transfer_in')).toHaveLength(0);
      });

      it('never creates a ReturnCredit for a custody-origin disposition, even value-credit-shaped dispositions like restock', async () => {
        const requestId = await walkCustodyToInspected();
        const before = credits.size;
        await service.recordDisposition(requestId, 'restock', null, 'worker-1');
        expect(credits.size).toBe(before);
      });
    });
  });
});
