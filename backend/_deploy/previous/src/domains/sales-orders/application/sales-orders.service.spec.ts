import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SalesOrdersService } from './sales-orders.service';
import { SalesOrder } from '../infrastructure/sales-order.entity';
import { SalesOrderLine } from '../infrastructure/sales-order-line.entity';
import { ProductsService } from '../../commerce/application/products.service';
import { PriceListsService } from '../../commerce/application/price-lists.service';
import { CustomersService } from '../../crm/application/customers.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ScopeService } from '../../../foundation/scope/scope.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { UsersService } from '../../../foundation/identity/users.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';

const WH = 'wh-1'; // the one warehouse every test creates orders against, unless a test says otherwise

/**
 * Proves the actual V1 commercial core end-to-end: order creation with
 * server-computed (never client-trusted) totals, and the full
 * Draft->Submitted->Supervisor->Manager approval chain via role-gated
 * transitions, plus the customer-scope enforcement point from blueprint
 * §22.
 */
describe('SalesOrdersService', () => {
  let service: SalesOrdersService;
  const orders = new Map<string, SalesOrder>();
  const lines: SalesOrderLine[] = [];
  const orderStates = new Map<string, string>();
  let idSeq = 0;

  const orderRepoMock = () => ({
    create: jest.fn((data: Partial<SalesOrder>) => ({ id: `so-${++idSeq}`, ...data }) as SalesOrder),
    save: jest.fn(async (o: SalesOrder) => {
      orders.set(o.id, o);
      return o;
    }),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => orders.get(where.id) ?? null),
    find: jest.fn(async (opts?: { where?: { salesRepUserId: string } }) => {
      const all = [...orders.values()];
      if (!opts?.where) return all;
      return all.filter((o) => o.salesRepUserId === opts.where!.salesRepUserId);
    }),
    findAndCount: jest.fn(async (opts?: { where?: { salesRepUserId?: string }; take?: number; skip?: number }) => {
      const all = [...orders.values()];
      const filtered = opts?.where?.salesRepUserId ? all.filter((o) => o.salesRepUserId === opts.where!.salesRepUserId) : all;
      const skip = opts?.skip ?? 0;
      const take = opts?.take ?? filtered.length;
      return [filtered.slice(skip, skip + take), filtered.length] as [SalesOrder[], number];
    }),
    remove: jest.fn(async (entity: SalesOrder) => {
      orders.delete(entity.id);
      return entity;
    }),
  });

  const lineRepoMock = () => ({
    create: jest.fn((data: Partial<SalesOrderLine>) => ({ id: `line-${++idSeq}`, ...data }) as SalesOrderLine),
    save: jest.fn(async (input: SalesOrderLine | SalesOrderLine[]) => {
      const arr = Array.isArray(input) ? input : [input];
      for (const l of arr) if (!lines.includes(l)) lines.push(l);
      return arr;
    }),
    find: jest.fn(async ({ where }: { where: { salesOrderId: string } }) =>
      lines.filter((l) => l.salesOrderId === where.salesOrderId),
    ),
    remove: jest.fn(async (entity: SalesOrderLine) => {
      const idx = lines.indexOf(entity);
      if (idx >= 0) lines.splice(idx, 1);
      return entity;
    }),
  });

  const getRepositoryMock = jest.fn((entity: unknown) => (entity === SalesOrder ? orderRepoMock() : lineRepoMock()));
  const transactionQueryMock = jest.fn(async () => [] as unknown[]);

  const dataSourceMock = {
    getRepository: getRepositoryMock,
    // NOTE: this in-memory mock does not actually roll back on a thrown
    // error mid-transaction (there's no real DB underneath it) — the
    // "no partial order survives an insufficient-stock line" guarantee
    // (TEST E) is proven against the real Postgres transaction live, not
    // here. What IS proven here: createOrder rejects when any line's
    // reservation fails, and every line up to that point already called
    // reserveStockInTransaction with the right arguments.
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) =>
      // `query` here backs deleteDraftOrder's own cleanup of now-parentless
      // stock_reservations/process_instances rows (a real orphan-rows gap
      // found live during a release-readiness DB integrity sweep) — tracked
      // separately from `dataSourceMock.query` above via its own spy so tests
      // can assert on the exact DELETE statements without touching the
      // edit-history read mock.
      fn({ getRepository: getRepositoryMock, query: transactionQueryMock }),
    ),
    // Order Edit History (CTO directive §1) — getOrderEditHistory's raw
    // audit_records read; defaults to empty, overridden per-test.
    query: jest.fn(async () => [] as unknown[]),
  };

  const productsMock = {
    getProductSnapshot: jest.fn(async (id: string) => {
      if (id === 'inactive-product') return { id, sku: 'X', name: 'Inactive', unitPrice: '10.00', status: 'draft' };
      return { id, sku: 'WIDGET', name: 'Widget', unitPrice: '25.00', status: 'active' };
    }),
  };
  const customersMock = {
    getWorkflowPolicySnapshot: jest.fn(async (customerId: string) =>
      customerId === 'cust-open-account' ? 'open_account' : 'standard',
    ),
    getPriceListId: jest.fn(async (customerId: string) => (customerId === 'cust-priced' ? 'pl-1' : null)),
    getCustomerSnapshot: jest.fn(async (customerId: string) =>
      customerId === 'cust-unknown' ? null : { id: customerId, code: 'C-1', name: 'Acme Trading', phone: '0100000000' },
    ),
  };
  const usersMock = {
    findById: jest.fn(async (id: string) => {
      const names: Record<string, string> = { 'rep-1': 'Rep One', 'rep-2': 'Rep Two', 'manager-1': 'Manager One' };
      if (!names[id]) throw new Error(`User "${id}" not found.`);
      return { id, fullName: names[id] };
    }),
  };
  const priceListsMock = {
    // pl-1 overrides prod-1 to 20.00 (base price is 25.00 per productsMock below); no override for any other product/list.
    getOverridePrice: jest.fn(async (priceListId: string, productId: string) =>
      priceListId === 'pl-1' && productId === 'prod-1' ? '20.00' : null,
    ),
    // Hotfix 3 (post-v1.0.2) — this test fixture has no Main/General list
    // concept set up (no test in this file exercises those tiers; that
    // behavior is covered directly in price-lists.service.spec.ts), so
    // this mirrors the OLD single-tier (customer-list-or-nothing) shape:
    // same customer-list check as getOverridePrice above, else no override.
    resolvePrice: jest.fn(async (customerPriceListId: string | null, productId: string) =>
      customerPriceListId === 'pl-1' && productId === 'prod-1'
        ? { price: '20.00', priceListId: 'pl-1' }
        : { price: null, priceListId: null },
    ),
  };
  const repSeqCounters = new Map<string, number>();
  const numberingMock = {
    registerDocumentType: jest.fn(async () => undefined),
    getNextNumber: jest.fn(async (documentType: string) => {
      if (documentType === 'sales_order') return 'SO-2026-000001';
      const next = (repSeqCounters.get(documentType) ?? 0) + 1;
      repSeqCounters.set(documentType, next);
      return `REP-${String(next).padStart(6, '0')}`;
    }),
  };
  const scopeMock = {
    assertAccess: jest.fn(async () => undefined),
    assign: jest.fn(async () => undefined),
  };
  const auditMock = { record: jest.fn(async () => undefined) };
  const authorizationMock = {
    getRoleKeysForUser: jest.fn(async (userId: string) => {
      if (userId === 'supervisor-1') return ['sales_supervisor'];
      if (userId === 'manager-1') return ['sales_manager'];
      if (userId === 'rep-1') return ['sales_rep'];
      if (userId === 'worker-1') return ['warehouse_worker'];
      if (userId === 'finance-1') return ['finance'];
      return [];
    }),
  };
  const processEngineMock = {
    start: jest.fn(async () => undefined),
    transition: jest.fn(async (_def: unknown, _type: string, orderId: string, action: string) => {
      const transitions: Record<string, string> = {
        submit: 'submitted',
        start_review: 'supervisor_review',
        supervisor_approve: 'manager_approval',
        manager_approve: 'deposit_verification',
        manager_approve_no_deposit: 'released', // Hotfix 6 (post-v1.0.2)
        verify_deposit: 'released',
        auto_release: 'released',
        expire_hold: 'draft',
      };
      orderStates.set(orderId, transitions[action]);
    }),
    getState: jest.fn(async (_def: unknown, _type: string, orderId: string) => orderStates.get(orderId) ?? 'draft'),
  };

  // Available stock per (warehouseId:productId) — 'scarce-product' starts
  // with only 5 units available at wh-1; every other product is
  // effectively unlimited for these tests' purposes.
  const availableStock = new Map<string, number>([[`${WH}:scarce-product`, 5]]);
  const reservationCalls: Array<{ warehouseId: string; productId: string; quantity: number; salesOrderId: string }> = [];
  const reservationStatusCalls: string[] = [];
  const inventoryMock = {
    reserveStockInTransaction: jest.fn(
      async (
        _manager: unknown,
        warehouseId: string,
        productId: string,
        quantity: number,
        salesOrderId: string,
        _actorUserId: string | null,
        status: string = 'active',
      ) => {
        const key = `${warehouseId}:${productId}`;
        const available = availableStock.has(key) ? availableStock.get(key)! : Number.POSITIVE_INFINITY;
        if (available < quantity) {
          throw new ConflictException(
            `Insufficient available stock for product "${productId}" in warehouse "${warehouseId}": requested ${quantity}, available ${available}.`,
          );
        }
        if (availableStock.has(key)) availableStock.set(key, available - quantity);
        const reservation = { id: `rsv-${reservationCalls.length + 1}`, warehouseId, productId, quantity, salesOrderId, status };
        reservationCalls.push({ warehouseId, productId, quantity, salesOrderId });
        reservationStatusCalls.push(status);
        return reservation;
      },
    ),
    getWarehouse: jest.fn(async (id: string) => ({ id, code: 'WH-1', name: 'Main Warehouse' })),
    confirmReservationsForOrder: jest.fn(async () => undefined),
    releasePreliminaryHoldsForOrder: jest.fn(async () => undefined),
    adjustReservationQuantityInTransaction: jest.fn(
      async (_manager: unknown, warehouseId: string, productId: string, salesOrderId: string, newQuantity: number) => {
        const key = `${warehouseId}:${productId}`;
        const available = availableStock.has(key) ? availableStock.get(key)! : Number.POSITIVE_INFINITY;
        if (available < newQuantity) {
          throw new ConflictException(
            `Insufficient available stock for product "${productId}" in warehouse "${warehouseId}": requested ${newQuantity}, available ${available}.`,
          );
        }
        return { id: `rsv-adj-${reservationCalls.length + 1}`, warehouseId, productId, quantity: newQuantity, salesOrderId, status: 'preliminary' };
      },
    ),
    releaseReservationForOrderProductInTransaction: jest.fn(async () => undefined),
  };

  beforeEach(async () => {
    orders.clear();
    lines.length = 0;
    orderStates.clear();
    repSeqCounters.clear();
    reservationCalls.length = 0;
    reservationStatusCalls.length = 0;
    availableStock.set(`${WH}:scarce-product`, 5);
    idSeq = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesOrdersService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: NumberingService, useValue: numberingMock },
        { provide: ScopeService, useValue: scopeMock },
        { provide: AuditService, useValue: auditMock },
        { provide: AuthorizationService, useValue: authorizationMock },
        { provide: ProcessEngineService, useValue: processEngineMock },
        { provide: ProductsService, useValue: productsMock },
        { provide: PriceListsService, useValue: priceListsMock },
        { provide: CustomersService, useValue: customersMock },
        { provide: UsersService, useValue: usersMock },
        { provide: InventoryService, useValue: inventoryMock },
      ],
    }).compile();
    service = moduleRef.get(SalesOrdersService);
  });

  it('computes the order total server-side from product price × quantity, never from client input', async () => {
    const order = await service.createOrder(
      'cust-1',
      'rep-1',
      [{ productId: 'prod-1', quantity: 3 }],
      'rep-1',
      WH, 'company_vehicles',
    );
    expect(order.totalAmount).toBe('75.00'); // 25.00 * 3 — no client-supplied total exists anywhere in this call
  });

  it('resolves the customer\'s assigned Price List override, keeping the base price as listPrice (Gap G-3)', async () => {
    const order = await service.createOrder(
      'cust-priced',
      'rep-1',
      [{ productId: 'prod-1', quantity: 2 }],
      'rep-1',
      WH, 'company_vehicles',
    );
    const [line] = await service.getOrderLines(order.id);
    expect(line.unitPrice).toBe('20.00'); // price-list override, not the 25.00 base
    expect(line.listPrice).toBe('25.00'); // product's own base price, unchanged
    expect(line.priceListId).toBe('pl-1');
    expect(order.totalAmount).toBe('40.00'); // 20.00 * 2
  });

  it('falls back to the product\'s base price when the customer has no Price List assigned', async () => {
    const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
    const [line] = await service.getOrderLines(order.id);
    expect(line.unitPrice).toBe('25.00');
    expect(line.listPrice).toBe('25.00');
    expect(line.priceListId).toBeNull();
  });

  it('falls back to the base price for a product the assigned Price List has no override for', async () => {
    const order = await service.createOrder(
      'cust-priced',
      'rep-1',
      [{ productId: 'prod-no-override', quantity: 1 }],
      'rep-1',
      WH, 'company_vehicles',
    );
    const [line] = await service.getOrderLines(order.id);
    expect(line.unitPrice).toBe('25.00'); // productsMock's default price for any id other than prod-1/inactive-product
    expect(line.priceListId).toBeNull();
  });

  it('nets a line discount off the line and order totals (Gap G-4)', async () => {
    const order = await service.createOrder(
      'cust-1',
      'rep-1',
      [{ productId: 'prod-1', quantity: 3, discountAmount: '15.00' }],
      'rep-1',
      WH, 'company_vehicles',
    );
    expect(order.totalAmount).toBe('60.00'); // (25.00 * 3) - 15.00
  });

  it('rejects a discount larger than the line\'s own gross total', async () => {
    await expect(
      service.createOrder(
        'cust-1',
        'rep-1',
        [{ productId: 'prod-1', quantity: 1, discountAmount: '999.00' }],
        'rep-1',
        WH, 'company_vehicles',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a negative discount', async () => {
    await expect(
      service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1, discountAmount: '-1' }], 'rep-1', WH, 'company_vehicles'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an order line referencing an inactive product', async () => {
    await expect(
      service.createOrder('cust-1', 'rep-1', [{ productId: 'inactive-product', quantity: 1 }], 'rep-1', WH, 'company_vehicles'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an order with zero lines', async () => {
    await expect(service.createOrder('cust-1', 'rep-1', [], 'rep-1', WH, 'company_vehicles')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an order with no warehouse (stock is reserved at creation time — CTO directive)', async () => {
    await expect(
      service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', '', 'company_vehicles'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces customer scope before creating an order (blueprint §22)', async () => {
    await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
    expect(scopeMock.assertAccess).toHaveBeenCalledWith('rep-1', 'customer', 'cust-1');
  });

  it('walks the full approval chain: submit auto-advances to supervisor_review, then supervisor/manager approve', async () => {
    const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');

    let status = await service.transitionOrder(order.id, 'submit', 'rep-1');
    expect(status).toBe('supervisor_review'); // submit + auto start_review

    status = await service.transitionOrder(order.id, 'supervisor_approve', 'supervisor-1');
    expect(status).toBe('manager_approval');

    status = await service.transitionOrder(order.id, 'manager_approve', 'manager-1');
    expect(status).toBe('deposit_verification');
  });

  it('open_account customer: submit releases immediately, no review/deposit stage (Gap G-1)', async () => {
    const order = await service.createOrder(
      'cust-open-account',
      'rep-1',
      [{ productId: 'prod-1', quantity: 1 }],
      'rep-1',
      WH, 'company_vehicles',
    );
    expect(order.workflowPolicy).toBe('open_account');

    const status = await service.transitionOrder(order.id, 'submit', 'rep-1');
    expect(status).toBe('released'); // submit + auto auto_release — no supervisor/manager/deposit stage
  });

  it('standard customer (default): submit still auto-advances only to supervisor_review, not released', async () => {
    const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
    expect(order.workflowPolicy).toBe('standard');
    const status = await service.transitionOrder(order.id, 'submit', 'rep-1');
    expect(status).toBe('supervisor_review');
  });

  it('rejects a supervisor-only action attempted by a plain sales rep', async () => {
    const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
    await service.transitionOrder(order.id, 'submit', 'rep-1');
    await expect(service.transitionOrder(order.id, 'supervisor_approve', 'rep-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('releaseAfterDepositVerified transitions the order to released (called only by Deposit Control)', async () => {
    const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
    orderStates.set(order.id, 'deposit_verification');
    const status = await service.releaseAfterDepositVerified(order.id, 'finance-1');
    expect(status).toBe('released');
  });

  describe('Preliminary Hold (CTO directive — Warehouse/Sales Order Ownership Flow)', () => {
    it('a standard-policy order reserves stock as "preliminary", not "active" — the deposit hasn\'t been approved yet', async () => {
      await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      expect(reservationStatusCalls).toEqual(['preliminary']);
    });

    it('an open-account order (no deposit gate) reserves straight to "active" — nothing will ever confirm a preliminary hold for it', async () => {
      await service.createOrder('cust-open-account', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      expect(reservationStatusCalls).toEqual(['active']);
    });

    it('releaseAfterDepositVerified confirms the preliminary holds before advancing the order (validate-before-commit ordering)', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      orderStates.set(order.id, 'deposit_verification');
      await service.releaseAfterDepositVerified(order.id, 'finance-1');
      expect(inventoryMock.confirmReservationsForOrder).toHaveBeenCalledWith(order.id, 'finance-1');
    });

    it('expireHoldForOrder releases the holds and moves the order back to draft', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      orderStates.set(order.id, 'supervisor_review'); // simulates 24h having passed while awaiting review

      await service.expireHoldForOrder(order.id, null);

      expect(inventoryMock.releasePreliminaryHoldsForOrder).toHaveBeenCalledWith(
        order.id,
        null,
        expect.stringContaining('24 hours'),
      );
      expect(orderStates.get(order.id)).toBe('draft');
    });

    it('expireHoldForOrder is a no-op on the order state once the order has already reached "released" (still releases any stray holds)', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      orderStates.set(order.id, 'released');

      await service.expireHoldForOrder(order.id, null);

      expect(inventoryMock.releasePreliminaryHoldsForOrder).toHaveBeenCalled();
      expect(orderStates.get(order.id)).toBe('released'); // never forced backward off an already-released order
    });
  });

  describe('Hotfix 6 (post-v1.0.2) — Create Sales Order Without a Deposit', () => {
    it('skipDeposit defaults to false and is persisted as false when omitted (existing behavior unchanged)', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      expect(order.skipDeposit).toBe(false);
    });

    it('skipDeposit=true is persisted on the created order', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles', true);
      expect(order.skipDeposit).toBe(true);
    });

    it('manager_approve on a skipDeposit order auto-advances straight to released, never landing in deposit_verification', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles', true);

      let status = await service.transitionOrder(order.id, 'submit', 'rep-1');
      expect(status).toBe('supervisor_review');

      status = await service.transitionOrder(order.id, 'supervisor_approve', 'supervisor-1');
      expect(status).toBe('manager_approval');

      status = await service.transitionOrder(order.id, 'manager_approve', 'manager-1');
      expect(status).toBe('released'); // NOT deposit_verification — the whole point of this hotfix
    });

    it('manager_approve on a NORMAL (skipDeposit=false) order still lands in deposit_verification, unchanged', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles', false);
      await service.transitionOrder(order.id, 'submit', 'rep-1');
      await service.transitionOrder(order.id, 'supervisor_approve', 'supervisor-1');
      const status = await service.transitionOrder(order.id, 'manager_approve', 'manager-1');
      expect(status).toBe('deposit_verification');
    });

    it('confirms preliminary stock holds before releasing a skipDeposit order (same validate-before-commit ordering as a normal deposit approval)', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles', true);
      await service.transitionOrder(order.id, 'submit', 'rep-1');
      await service.transitionOrder(order.id, 'supervisor_approve', 'supervisor-1');
      await service.transitionOrder(order.id, 'manager_approve', 'manager-1');
      expect(inventoryMock.confirmReservationsForOrder).toHaveBeenCalledWith(order.id, 'manager-1');
    });

    it('supervisor/manager role gating is completely unaffected by skipDeposit — a plain sales rep still cannot supervisor-approve', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles', true);
      await service.transitionOrder(order.id, 'submit', 'rep-1');
      await expect(service.transitionOrder(order.id, 'supervisor_approve', 'rep-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('manager_approve_no_deposit is not a directly client-reachable action (internal auto-advance only, same default-deny as start_review/verify_deposit)', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles', true);
      orderStates.set(order.id, 'manager_approval');
      await expect(service.transitionOrder(order.id, 'manager_approve_no_deposit', 'manager-1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('Order Edit During Review (CTO directive §1)', () => {
    async function createAndAdvanceToSupervisorReview() {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 2 }], 'rep-1', WH, 'company_vehicles');
      await service.transitionOrder(order.id, 'submit', 'rep-1'); // -> supervisor_review
      const lines = await service.getOrderLines(order.id);
      return { order, line: lines[0] };
    }

    it('a supervisor may edit a line during supervisor_review; the order stays in the same stage afterward', async () => {
      const { order, line } = await createAndAdvanceToSupervisorReview();
      const updated = await service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 5 }], 'supervisor-1');
      expect(await service.getOrderStatus(updated.id)).toBe('supervisor_review');
      const newLines = await service.getOrderLines(order.id);
      expect(newLines[0].quantity).toBe(5);
    });

    it('rejects a plain rep editing a line during supervisor_review', async () => {
      const { order, line } = await createAndAdvanceToSupervisorReview();
      await expect(service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 5 }], 'rep-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects a supervisor editing during manager_approval (wrong stage for that role)', async () => {
      const { order, line } = await createAndAdvanceToSupervisorReview();
      await service.transitionOrder(order.id, 'supervisor_approve', 'supervisor-1'); // -> manager_approval
      await expect(service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 5 }], 'supervisor-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('a manager may edit during manager_approval', async () => {
      const { order, line } = await createAndAdvanceToSupervisorReview();
      await service.transitionOrder(order.id, 'supervisor_approve', 'supervisor-1'); // -> manager_approval
      const updated = await service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 7 }], 'manager-1');
      expect(await service.getOrderStatus(updated.id)).toBe('manager_approval');
    });

    it('rejects editing an order not currently in an editable stage (e.g. still draft)', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 2 }], 'rep-1', WH, 'company_vehicles');
      const lines = await service.getOrderLines(order.id);
      await expect(service.updateOrderLines(order.id, [{ lineId: lines[0].id, quantity: 5 }], 'supervisor-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('a quantity change re-validates and re-reserves stock through Inventory — insufficient stock rejects the whole edit', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'scarce-product', quantity: 2 }], 'rep-1', WH, 'company_vehicles');
      await service.transitionOrder(order.id, 'submit', 'rep-1');
      const lines = await service.getOrderLines(order.id);

      await expect(
        service.updateOrderLines(order.id, [{ lineId: lines[0].id, quantity: 999 }], 'supervisor-1'),
      ).rejects.toBeInstanceOf(ConflictException);

      // Nothing changed — the line still shows its original quantity.
      const unchanged = await service.getOrderLines(order.id);
      expect(unchanged[0].quantity).toBe(2);
    });

    it('re-resolves the price with the same manager > rep > price-list precedence, using the line\'s own already-snapshotted price-list baseline', async () => {
      const { order, line } = await createAndAdvanceToSupervisorReview();
      expect(line.unitPrice).toBe('25.00'); // base price for 'prod-1' in this test fixture, no price list

      await service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 2, repPrice: '80.00' }], 'supervisor-1');
      let updatedLine = (await service.getOrderLines(order.id))[0];
      expect(updatedLine.unitPrice).toBe('80.00'); // rep price now wins

      await service.transitionOrder(order.id, 'supervisor_approve', 'supervisor-1'); // -> manager_approval
      await service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 2, managerPrice: '50.00' }], 'manager-1');
      updatedLine = (await service.getOrderLines(order.id))[0];
      expect(updatedLine.unitPrice).toBe('50.00'); // manager price beats the still-set rep price
    });

    it('rejects a supervisor (non-manager role) supplying a managerPrice — never silently ignored', async () => {
      const { order, line } = await createAndAdvanceToSupervisorReview();
      const updated = await service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 2, managerPrice: '9.99' }], 'supervisor-1');
      const updatedLine = (await service.getOrderLines(order.id))[0];
      expect(updatedLine.managerPrice).toBeNull(); // silently dropped for an unauthorized role, exactly like createOrder's own rule
      expect(updated.id).toBe(order.id);
    });

    it('records one audit entry per changed field, with old and new values', async () => {
      const { order, line } = await createAndAdvanceToSupervisorReview();
      auditMock.record.mockClear();

      await service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 9, discountAmount: '10.00' }], 'supervisor-1');

      type AuditEntry = { action: string; before: unknown; after: unknown };
      const fieldEdits = (auditMock.record.mock.calls as unknown as Array<[AuditEntry]>)
        .map(([entry]) => entry)
        .filter((e) => e.action === 'sales.order.line_edited');
      const fields = fieldEdits.map((e) => (e.after as { field: string }).field);
      expect(fields).toContain('quantity');
      expect(fields).toContain('discountAmount');
      const quantityEdit = fieldEdits.find((e) => (e.after as { field: string }).field === 'quantity')!;
      expect((quantityEdit.before as { value: number }).value).toBe(2);
      expect((quantityEdit.after as { value: number }).value).toBe(9);
    });

    it('throws for a line id that does not belong to the order', async () => {
      const { order } = await createAndAdvanceToSupervisorReview();
      await expect(
        service.updateOrderLines(order.id, [{ lineId: 'not-a-real-line-id', quantity: 1 }], 'supervisor-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Post-Deposit-Approval Edit Control (CTO directive §1)', () => {
    async function createReleasedOrder() {
      // open_account fast-path: submit alone reaches 'released' with no
      // review/deposit stage — the shortest route to the state under test.
      const order = await service.createOrder('cust-open-account', 'rep-1', [{ productId: 'prod-1', quantity: 2 }], 'rep-1', WH, 'company_vehicles');
      await service.transitionOrder(order.id, 'submit', 'rep-1');
      const lines = await service.getOrderLines(order.id);
      return { order, line: lines[0] };
    }

    it('rejects a sales_rep, supervisor, or manager editing a released order (403, not the old blanket conflict)', async () => {
      const { order, line } = await createReleasedOrder();
      await expect(service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 5 }], 'rep-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 5 }], 'supervisor-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 5 }], 'manager-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects an admin editing a released order without a reason', async () => {
      const { order, line } = await createReleasedOrder();
      authorizationMock.getRoleKeysForUser.mockImplementationOnce(async () => ['admin']);
      await expect(service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 5 }], 'admin-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // a whitespace-only reason is treated as no reason
      authorizationMock.getRoleKeysForUser.mockImplementationOnce(async () => ['admin']);
      await expect(
        service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 5 }], 'admin-1', '   '),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allows an admin to edit a released order with a reason, and records a distinct post-release audit action carrying the reason', async () => {
      const { order, line } = await createReleasedOrder();
      auditMock.record.mockClear();
      authorizationMock.getRoleKeysForUser.mockImplementationOnce(async () => ['admin']);

      const updated = await service.updateOrderLines(
        order.id,
        [{ lineId: line.id, quantity: 5 }],
        'admin-1',
        'Customer requested quantity change by phone',
      );
      expect(await service.getOrderStatus(updated.id)).toBe('released');
      expect((await service.getOrderLines(order.id))[0].quantity).toBe(5);

      type AuditEntry = { action: string; before: unknown; after: unknown };
      const postReleaseEdits = (auditMock.record.mock.calls as unknown as Array<[AuditEntry]>)
        .map(([entry]) => entry)
        .filter((e) => e.action === 'sales.order.post_release_edit');
      expect(postReleaseEdits.length).toBeGreaterThan(0);
      const quantityEdit = postReleaseEdits.find((e) => (e.after as { field: string }).field === 'quantity')!;
      expect((quantityEdit.after as { reason: string }).reason).toBe('Customer requested quantity change by phone');
      expect((quantityEdit.after as { editedDuringStatus: string }).editedDuringStatus).toBe('released');
      // never mislabeled as the review-stage action
      expect(
        (auditMock.record.mock.calls as unknown as Array<[AuditEntry]>).some(([e]) => e.action === 'sales.order.line_edited'),
      ).toBe(false);
    });

    it('allows a finance user to edit a released order with a reason', async () => {
      const { order, line } = await createReleasedOrder();
      authorizationMock.getRoleKeysForUser.mockImplementationOnce(async () => ['finance']);
      await service.updateOrderLines(order.id, [{ lineId: line.id, quantity: 3 }], 'finance-1', 'Warehouse correction');
      expect((await service.getOrderLines(order.id))[0].quantity).toBe(3);
    });

    it('does NOT require a reason for the pre-existing review-stage edits (regression — the pre-deposit workflow is untouched)', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 2 }], 'rep-1', WH, 'company_vehicles');
      await service.transitionOrder(order.id, 'submit', 'rep-1'); // -> supervisor_review
      const lines = await service.getOrderLines(order.id);
      await expect(
        service.updateOrderLines(order.id, [{ lineId: lines[0].id, quantity: 5 }], 'supervisor-1'),
      ).resolves.toBeDefined();
    });
  });

  describe('getOrderEditHistory (CTO directive §1)', () => {
    it('maps raw audit_records rows into an enriched, oldest-first history with actor names resolved', async () => {
      const rows = [
        {
          seq: 1,
          timestamp: new Date('2026-08-24T10:00:00Z'),
          actorUserId: 'manager-1',
          action: 'sales.order.line_edited',
          resourceId: 'line-99',
          before: { field: 'quantity', value: 2 },
          after: { field: 'quantity', value: 5, salesOrderId: 'so-77', productId: 'prod-1', editedDuringStatus: 'manager_approval' },
        },
        {
          seq: 2,
          timestamp: new Date('2026-08-24T11:00:00Z'),
          actorUserId: 'manager-1',
          action: 'sales.order.post_release_edit',
          resourceId: 'line-99',
          before: { field: 'quantity', value: 5 },
          after: {
            field: 'quantity',
            value: 8,
            salesOrderId: 'so-77',
            productId: 'prod-1',
            editedDuringStatus: 'released',
            reason: 'Customer request',
          },
        },
      ];
      (dataSourceMock.query as jest.Mock).mockImplementationOnce(async () => rows);

      const history = await service.getOrderEditHistory('so-77');

      expect(history).toHaveLength(2);
      expect(history[0].seq).toBe(1); // oldest first
      expect(history[1]).toMatchObject({
        actorUserId: 'manager-1',
        actorName: 'Manager One',
        action: 'sales.order.post_release_edit',
        field: 'quantity',
        before: 5,
        after: 8,
        reason: 'Customer request',
        editedDuringStatus: 'released',
      });
      expect(history[0].reason).toBeNull(); // the review-stage entry never carried a reason
    });
  });

  describe('editDraftOrder (Order Edit at Draft — full add/remove/change, before submission)', () => {
    it('the owning rep can add a new line to their own draft order', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 2 }], 'rep-1', WH, 'company_vehicles');
      const existing = (await service.getOrderLines(order.id))[0];

      const updated = await service.editDraftOrder(
        order.id,
        [{ lineId: existing.id, productId: 'prod-1', quantity: 2 }, { productId: 'prod-2', quantity: 3 }],
        'rep-1',
      );

      const newLines = await service.getOrderLines(order.id);
      expect(newLines).toHaveLength(2);
      expect(updated.totalAmount).toBe('125.00'); // (25*2) + (25*3), both price 25.00 in the fixture
    });

    it('the owning rep can remove an existing line, releasing its reservation', async () => {
      const order = await service.createOrder(
        'cust-1',
        'rep-1',
        [{ productId: 'prod-1', quantity: 2 }, { productId: 'prod-2', quantity: 1 }],
        'rep-1',
        WH, 'company_vehicles',
      );
      const [lineA, lineB] = await service.getOrderLines(order.id);

      const updated = await service.editDraftOrder(order.id, [{ lineId: lineA.id, productId: lineA.productId, quantity: 2 }], 'rep-1');

      const remaining = await service.getOrderLines(order.id);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(lineA.id);
      expect(updated.totalAmount).toBe('50.00');
      expect(inventoryMock.releaseReservationForOrderProductInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        lineB.productId,
        order.id,
        'rep-1',
      );
    });

    it('rejects a rep editing a DIFFERENT rep\'s draft order', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 2 }], 'rep-1', WH, 'company_vehicles');
      const existing = (await service.getOrderLines(order.id))[0];
      await expect(
        service.editDraftOrder(order.id, [{ lineId: existing.id, productId: 'prod-1', quantity: 2 }], 'rep-2'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects editing once the order has left draft (e.g. submitted for review)', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 2 }], 'rep-1', WH, 'company_vehicles');
      const existing = (await service.getOrderLines(order.id))[0];
      await service.transitionOrder(order.id, 'submit', 'rep-1');
      await expect(
        service.editDraftOrder(order.id, [{ lineId: existing.id, productId: 'prod-1', quantity: 3 }], 'rep-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('an admin may edit any rep\'s draft order', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 2 }], 'rep-1', WH, 'company_vehicles');
      const existing = (await service.getOrderLines(order.id))[0];
      authorizationMock.getRoleKeysForUser.mockImplementationOnce(async () => ['admin']);
      await expect(
        service.editDraftOrder(order.id, [{ lineId: existing.id, productId: 'prod-1', quantity: 5 }], 'admin-1'),
      ).resolves.toBeDefined();
    });

    it('a rep editing OTHER lines never strips an existing manager-price override off a line they cannot touch', async () => {
      // A manager built this draft order under the rep's name with a managerPrice already set on the line.
      const order = await service.createOrder(
        'cust-1',
        'rep-1',
        [{ productId: 'prod-1', quantity: 2, managerPrice: '99.00' }],
        'manager-1',
        WH, 'company_vehicles',
      );
      const existing = (await service.getOrderLines(order.id))[0];
      expect(existing.managerPrice).toBe('99.00');

      // The rep now edits the draft, only to add an unrelated second line — never touching the manager price.
      await service.editDraftOrder(
        order.id,
        [{ lineId: existing.id, productId: existing.productId, quantity: 2 }, { productId: 'prod-2', quantity: 1 }],
        'rep-1',
      );

      const afterEdit = (await service.getOrderLines(order.id)).find((l) => l.id === existing.id)!;
      expect(afterEdit.managerPrice).toBe('99.00'); // preserved, not silently dropped
      expect(afterEdit.unitPrice).toBe('99.00');
    });

    it('an added line whose stock is insufficient rolls back — the whole edit is rejected', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      const existing = (await service.getOrderLines(order.id))[0];
      await expect(
        service.editDraftOrder(
          order.id,
          [{ lineId: existing.id, productId: 'prod-1', quantity: 1 }, { productId: 'scarce-product', quantity: 999 }],
          'rep-1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('shipping method (CTO directive §2)', () => {
    it('stores the shipping method on a new order and returns it', async () => {
      const orderVehicles = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      expect(orderVehicles.shippingMethod).toBe('company_vehicles');

      const orderCompany = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'shipping_company');
      expect(orderCompany.shippingMethod).toBe('shipping_company');
    });

    it('rejects an invalid shipping method', async () => {
      await expect(
        service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'carrier_pigeon' as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('deleteDraftOrder (CTO directive §2 — draft deletion, own drafts only)', () => {
    it('the owning rep can delete their own draft order, releasing every line\'s reservation', async () => {
      const order = await service.createOrder(
        'cust-1',
        'rep-1',
        [{ productId: 'prod-1', quantity: 2 }, { productId: 'prod-2', quantity: 1 }],
        'rep-1',
        WH,
        'company_vehicles',
      );
      inventoryMock.releaseReservationForOrderProductInTransaction.mockClear();

      await service.deleteDraftOrder(order.id, 'rep-1');

      expect(inventoryMock.releaseReservationForOrderProductInTransaction).toHaveBeenCalledTimes(2);
      expect(inventoryMock.releaseReservationForOrderProductInTransaction).toHaveBeenCalledWith(expect.anything(), 'prod-1', order.id, 'rep-1');
      expect(inventoryMock.releaseReservationForOrderProductInTransaction).toHaveBeenCalledWith(expect.anything(), 'prod-2', order.id, 'rep-1');
      await expect(service.getOrder(order.id, 'rep-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('an admin can delete a different rep\'s draft order', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      authorizationMock.getRoleKeysForUser.mockImplementationOnce(async () => ['admin']);
      await expect(service.deleteDraftOrder(order.id, 'admin-1')).resolves.toBeUndefined();
    });

    it('rejects a DIFFERENT rep deleting someone else\'s draft', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      await expect(service.deleteDraftOrder(order.id, 'rep-2')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects deleting an order that has left draft status', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      await service.transitionOrder(order.id, 'submit', 'rep-1'); // -> supervisor_review
      await expect(service.deleteDraftOrder(order.id, 'rep-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('translates a foreign-key violation (a deposit already recorded against the order) into a clean conflict, not a raw 500', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      dataSourceMock.transaction.mockImplementationOnce(async () => {
        const err: any = new Error('update or delete on table "sales_orders" violates foreign key constraint on table "deposits"');
        err.code = '23503';
        throw err;
      });
      await expect(service.deleteDraftOrder(order.id, 'rep-1')).rejects.toBeInstanceOf(ConflictException);
      // the order must NOT have been removed from the audit trail's perspective — it's still there since the transaction never committed
      expect(orders.has(order.id)).toBe(true);
    });

    it('writes an audit record for the deletion', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      auditMock.record.mockClear();
      await service.deleteDraftOrder(order.id, 'rep-1');
      expect(auditMock.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'sales.order.deleted', resourceId: order.id }));
    });

    it('REAL BUG FOUND LIVE (release-readiness DB integrity sweep) — also purges the now-parentless stock_reservations and process_instances rows, not just the order/lines, so a hard-deleted draft leaves no orphan referencing its now-nonexistent salesOrderId', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      transactionQueryMock.mockClear();
      await service.deleteDraftOrder(order.id, 'rep-1');
      expect(transactionQueryMock).toHaveBeenCalledWith('DELETE FROM stock_reservations WHERE "salesOrderId" = $1', [order.id]);
      expect(transactionQueryMock).toHaveBeenCalledWith(
        'DELETE FROM process_instances WHERE "entityType" = $1 AND "entityId" = $2',
        ['sales_order', order.id],
      );
    });
  });

  describe('per-rep order sequence (CTO instruction)', () => {
    it('starts at 1 for a rep\'s first order and increments per rep, independent of other reps', async () => {
      const first = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      const second = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      expect(first.repSequenceNumber).toBe(1);
      expect(second.repSequenceNumber).toBe(2);

      const otherRepFirst = await service.createOrder('cust-1', 'rep-2', [{ productId: 'prod-1', quantity: 1 }], 'rep-2', WH, 'company_vehicles');
      expect(otherRepFirst.repSequenceNumber).toBe(1); // independent counter, not 3
    });
  });

  describe('three-tier line pricing (CTO instruction)', () => {
    it('a rep price overrides the list price', async () => {
      const order = await service.createOrder(
        'cust-1',
        'rep-1',
        [{ productId: 'prod-1', quantity: 2, repPrice: '22.00' }],
        'rep-1',
        WH, 'company_vehicles',
      );
      const [line] = await service.getOrderLines(order.id);
      expect(line.unitPrice).toBe('22.00');
      expect(line.repPrice).toBe('22.00');
      expect(line.listPrice).toBe('25.00'); // base price, unchanged reference
      expect(order.totalAmount).toBe('44.00'); // 22.00 * 2
    });

    it('a manager price overrides both the rep price and the list price, when the actor is a manager', async () => {
      const order = await service.createOrder(
        'cust-1',
        'manager-1',
        [{ productId: 'prod-1', quantity: 1, repPrice: '22.00', managerPrice: '18.00' }],
        'manager-1',
        WH, 'company_vehicles',
      );
      const [line] = await service.getOrderLines(order.id);
      expect(line.unitPrice).toBe('18.00');
      expect(line.repPrice).toBe('22.00'); // still recorded, even though it lost precedence
      expect(line.managerPrice).toBe('18.00');
    });

    it('rejects a managerPrice supplied by a plain sales_rep — the whole order, not silently ignored', async () => {
      await expect(
        service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1, managerPrice: '18.00' }], 'rep-1', WH, 'company_vehicles'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a negative repPrice', async () => {
      await expect(
        service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1, repPrice: '-5' }], 'rep-1', WH, 'company_vehicles'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a manager MAY create an order under a different rep\'s name (needed to ever set a manager price)', async () => {
      const order = await service.createOrder(
        'cust-1',
        'rep-1',
        [{ productId: 'prod-1', quantity: 1, managerPrice: '18.00' }],
        'manager-1', // actor is the manager, order still belongs to rep-1
        WH, 'company_vehicles',
      );
      expect(order.salesRepUserId).toBe('rep-1');
      const [line] = await service.getOrderLines(order.id);
      expect(line.unitPrice).toBe('18.00');
    });

    it('rejects a plain sales_rep creating an order under a DIFFERENT rep\'s name', async () => {
      await expect(
        service.createOrder('cust-1', 'rep-2', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a rejected managerPrice attempt does NOT burn a rep sequence slot (found live: it did, before the auth check was moved ahead of the Numbering Engine calls)', async () => {
      await expect(
        service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1, managerPrice: '18.00' }], 'rep-1', WH, 'company_vehicles'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      expect(order.repSequenceNumber).toBe(1); // not 2 — the failed attempt above consumed nothing
    });

    it('persists the Price List-resolved price on its own column, distinct from the raw base price (REAL BUG FOUND LIVE: a "150 -> 8" line nobody could trace)', async () => {
      const order = await service.createOrder(
        'cust-priced',
        'rep-1',
        [{ productId: 'prod-1', quantity: 1 }], // pl-1 overrides prod-1 to 20.00; no rep/manager override
        'rep-1',
        WH, 'company_vehicles',
      );
      const [line] = await service.getOrderLines(order.id);
      expect(line.listPrice).toBe('25.00'); // raw base, unchanged
      expect(line.priceListPrice).toBe('20.00'); // the Price List's own resolved price — now visible on its own
      expect(line.unitPrice).toBe('20.00'); // nothing else applies, so this equals priceListPrice
    });

    it('priceListPrice equals the base price when no Price List override applies (no silent fallback to anything else)', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      const [line] = await service.getOrderLines(order.id);
      expect(line.priceListPrice).toBe('25.00');
      expect(line.priceListPrice).toBe(line.listPrice);
    });
  });

  describe('stock availability at order creation (CTO directive — PRIORITY 2)', () => {
    it('reserves every line\'s stock in the SAME transaction as the order, against the chosen warehouse', async () => {
      const order = await service.createOrder(
        'cust-1',
        'rep-1',
        [{ productId: 'prod-1', quantity: 3 }],
        'rep-1',
        WH, 'company_vehicles',
      );
      expect(reservationCalls).toContainEqual({ warehouseId: WH, productId: 'prod-1', quantity: 3, salesOrderId: order.id });
    });

    it('rejects order creation when a line requests more than is available (TEST B: 6 > 5 available)', async () => {
      await expect(
        service.createOrder('cust-1', 'rep-1', [{ productId: 'scarce-product', quantity: 6 }], 'rep-1', WH, 'company_vehicles'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('accepts exactly the available quantity (TEST B: 5 == 5 available)', async () => {
      const order = await service.createOrder(
        'cust-1',
        'rep-1',
        [{ productId: 'scarce-product', quantity: 5 }],
        'rep-1',
        WH, 'company_vehicles',
      );
      expect(order.id).toBeDefined();
      expect(reservationCalls).toContainEqual({ warehouseId: WH, productId: 'scarce-product', quantity: 5, salesOrderId: order.id });
    });

    it('rejects the whole multi-line order when ONE line is short, even though an earlier line already reserved successfully (TEST E)', async () => {
      await expect(
        service.createOrder(
          'cust-1',
          'rep-1',
          [
            { productId: 'prod-1', quantity: 2 }, // plenty available, reserves fine
            { productId: 'scarce-product', quantity: 999 }, // impossible — the whole call must still reject
          ],
          'rep-1',
          WH, 'company_vehicles',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('getOrderDetailView (CTO instruction: show customer name/phone, rep, and creator on the order screen)', () => {
    it('enriches the order with customer name/phone, the rep\'s name, and the actual creator\'s name', async () => {
      const order = await service.createOrder(
        'cust-1',
        'rep-1',
        [{ productId: 'prod-1', quantity: 1, managerPrice: '18.00' }],
        'manager-1', // creator differs from the order's own rep
        WH, 'company_vehicles',
      );
      const view = await service.getOrderDetailView(order.id, 'manager-1');
      expect(view.customerName).toBe('Acme Trading');
      expect(view.customerPhone).toBe('0100000000');
      expect(view.salesRepName).toBe('Rep One'); // salesRepUserId is rep-1, not the actor
      expect(view.createdByName).toBe('Manager One');
      expect(view.warehouseName).toBe('WH-1 — Main Warehouse');
    });

    it('degrades to null fields rather than throwing when the customer or a user lookup comes back empty', async () => {
      const order = await service.createOrder('cust-unknown', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      const view = await service.getOrderDetailView(order.id, 'rep-1');
      expect(view.customerName).toBeNull();
      expect(view.customerPhone).toBeNull();
      expect(view.createdByName).toBe('Rep One');
    });
  });

  describe('warehouse_worker visibility (CTO directive — Fulfillment dashboard rework: REAL BUG FOUND LIVE, a warehouse worker\'s released-order picker was always empty)', () => {
    it('listOrders returns every order to a warehouse_worker, same as a reviewer/admin — not scoped to salesRepUserId, which a worker never matches', async () => {
      await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      await service.createOrder('cust-1', 'rep-2', [{ productId: 'prod-1', quantity: 1 }], 'rep-2', WH, 'company_vehicles');
      const asWorker = await service.listOrders('worker-1');
      expect(asWorker).toHaveLength(2);
    });

    it('getOrder lets a warehouse_worker open an order\'s detail despite never being Scope-granted on it', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      await expect(service.getOrder(order.id, 'worker-1')).resolves.toBeTruthy();
    });
  });

  describe('listOrdersPage (pagination audit fix, MASTER_PROJECT_STATUS.md §6 — offset/limit math and total-under-filters)', () => {
    it('paginates a reviewer\'s full visible set correctly: page 1 and page 2 return disjoint rows, sorted newest-first, and total reflects every order, not just the page', async () => {
      for (let i = 0; i < 5; i++) {
        await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      }
      const page1 = await service.listOrdersPage('manager-1', { page: 1, pageSize: 2 });
      const page2 = await service.listOrdersPage('manager-1', { page: 2, pageSize: 2 });
      const page3 = await service.listOrdersPage('manager-1', { page: 3, pageSize: 2 });

      expect(page1.total).toBe(5);
      expect(page2.total).toBe(5);
      expect(page1.rows).toHaveLength(2);
      expect(page2.rows).toHaveLength(2);
      expect(page3.rows).toHaveLength(1); // last, partial page
      const page1Ids = page1.rows.map((o) => o.id);
      const page2Ids = page2.rows.map((o) => o.id);
      expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false); // no overlap between pages
    });

    it('applies the same Scope-vs-Role filter as listOrders: a plain sales_rep only ever sees, and is only ever counted against, their OWN orders', async () => {
      await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      await service.createOrder('cust-1', 'rep-2', [{ productId: 'prod-1', quantity: 1 }], 'rep-2', WH, 'company_vehicles');

      const asRep1 = await service.listOrdersPage('rep-1', { page: 1, pageSize: 50 });
      expect(asRep1.total).toBe(1);
      expect(asRep1.rows).toHaveLength(1);
      expect(asRep1.rows[0].salesRepUserId).toBe('rep-1');

      const asAdmin = await service.listOrdersPage('manager-1', { page: 1, pageSize: 50 });
      expect(asAdmin.total).toBe(2);
    });
  });

  describe('finance visibility (REAL BUG FOUND LIVE — Post-Deposit-Approval Edit Control verification, CTO directive §1: a finance user got a bare 404 approving a real pending deposit because DepositsService.approveDeposit calls getOrder internally, and finance was never in the "sees everything" role set here, despite being allowed by the deposits route\'s own @RequireRole gate)', () => {
    it('getOrder lets a finance actor open an order\'s detail without ever calling Scope, same as admin/warehouse_worker', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      scopeMock.assertAccess.mockClear();

      await expect(service.getOrder(order.id, 'finance-1')).resolves.toBeTruthy();
      expect(scopeMock.assertAccess).not.toHaveBeenCalled();
    });

    it('getOrder still enforces Scope for a plain sales_rep who is not the order owner (control case)', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      scopeMock.assertAccess.mockClear();

      await service.getOrder(order.id, 'rep-2');
      expect(scopeMock.assertAccess).toHaveBeenCalledWith('rep-2', 'sales_order', order.id);
    });
  });

  describe('getOrderSnapshot (cross-domain read contract for Delivery\'s Treasury-remittance bridge)', () => {
    it('resolves id/orderNumber/customerId/salesRepUserId without going through Scope-gated getOrder', async () => {
      const order = await service.createOrder('cust-1', 'rep-1', [{ productId: 'prod-1', quantity: 1 }], 'rep-1', WH, 'company_vehicles');
      const snapshot = await service.getOrderSnapshot(order.id);
      expect(snapshot).toEqual({ id: order.id, orderNumber: order.orderNumber, customerId: 'cust-1', salesRepUserId: 'rep-1' });
    });

    it('returns null for an unknown order rather than throwing', async () => {
      expect(await service.getOrderSnapshot('no-such-id')).toBeNull();
    });
  });
});
