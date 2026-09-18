import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { DeliveryService } from './delivery.service';
import { Collection } from '../infrastructure/collection.entity';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { FulfillmentService } from '../../fulfillment/application/fulfillment.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { InvoiceService } from '../../customer-finance/application/invoices.service';

describe('DeliveryService', () => {
  let service: DeliveryService;
  const publishedTopics: string[] = [];
  const records = new Map<string, Collection>();
  let seq = 0;

  const repoFor = () => ({
    create: jest.fn(
      (d: Partial<Collection>) =>
        ({
          id: `rec-${++seq}`,
          remittanceStatus: 'pending',
          remittedAt: null,
          treasuryTransactionId: null,
          custodyAccountId: null,
          custodyTransactionId: null,
          ...d,
        }) as Collection,
    ),
    save: jest.fn(async (r: Collection) => {
      records.set(r.id, r);
      return r;
    }),
    findOne: jest.fn(async ({ where }: { where: { id?: string; shipmentId?: string } }) => {
      if (where.id) return records.get(where.id) ?? null;
      if (where.shipmentId) return [...records.values()].find((r) => r.shipmentId === where.shipmentId) ?? null;
      return null;
    }),
    find: jest.fn(async ({ where }: { where?: { remittanceStatus?: string } } = {}) =>
      [...records.values()].filter((r) => !where?.remittanceStatus || r.remittanceStatus === where.remittanceStatus),
    ),
  });

  const getRepositoryMock = jest.fn(repoFor);
  const dataSourceMock = {
    getRepository: getRepositoryMock,
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn({ getRepository: getRepositoryMock })),
  };

  // 'ship-1' has a custodian (custody account 'acct-custody-1', settlement
  // 'acct-settlement-1'); 'ship-no-custodian' has none at all (plain
  // in-house driver delivery — the ORIGINAL, pre-custody-directive path).
  const shipmentsMock = {
    transitionShipment: jest.fn(async () => 'delivered'),
    assertDriverOrAdmin: jest.fn(async () => undefined),
    getShipmentSnapshot: jest.fn(async (id: string) => {
      if (id === 'ship-1') return { id, fulfillmentOrderId: 'fo-1', shippingCompanyId: 'sc-1', vehicleId: null, codAmount: '150.00' };
      if (id === 'ship-no-custodian') return { id, fulfillmentOrderId: 'fo-2', shippingCompanyId: null, vehicleId: null, codAmount: null };
      if (id === 'ship-no-settlement') return { id, fulfillmentOrderId: 'fo-3', shippingCompanyId: 'sc-2', vehicleId: null, codAmount: '80.00' };
      return null;
    }),
    getCustodianForShipment: jest.fn(async (id: string) => {
      if (id === 'ship-1') return { custodyAccountId: 'acct-custody-1', settlementAccountId: 'acct-settlement-1' };
      if (id === 'ship-no-settlement') return { custodyAccountId: 'acct-custody-2', settlementAccountId: null };
      return null;
    }),
    // CTO directive (reconcile the Preparation -> Shipping handoff) — 'wh-custody-1' stands in for wherever a custody transfer left the goods.
    getCurrentCustodyWarehouseId: jest.fn(async (id: string) => (id === 'ship-1' ? 'wh-custody-1' : null)),
  };
  const fulfillmentMock = {
    getFulfillmentOrder: jest.fn(async (id: string) => ({ id, salesOrderId: 'so-1', warehouseId: 'wh-1', createdAt: new Date() })),
  };
  const salesOrdersMock = {
    getOrderSnapshot: jest.fn(async (id: string) => ({ id, orderNumber: 'SO-2026-000001', customerId: 'cust-1' })),
  };
  const treasuryMock = {
    cashIn: jest.fn(async (accountId: string) => ({ id: `cashin-${accountId}-${++seq}`, accountId })),
    transfer: jest.fn(async (sourceAccountId: string, destinationAccountId: string) => ({
      out: { id: `transfer-out-${sourceAccountId}-${++seq}`, accountId: sourceAccountId },
      in: { id: `transfer-in-${destinationAccountId}-${++seq}`, accountId: destinationAccountId },
    })),
  };
  const inventoryMock = {
    fulfillReservationsForOrder: jest.fn(async () => undefined),
  };
  const auditMock = { record: jest.fn(async () => undefined) };
  const eventsMock = {
    publish: jest.fn(async (_m: unknown, topic: string) => {
      publishedTopics.push(topic);
    }),
  };
  const postedLedgerEntries: Array<Record<string, unknown>> = [];
  const customerLedgerMock = {
    postEntry: jest.fn(async (input: Record<string, unknown>) => {
      postedLedgerEntries.push(input);
      return { id: `cle-${postedLedgerEntries.length}`, ...input };
    }),
  };
  const invoicesMock = {
    findOpenInvoiceForOrder: jest.fn(async (): Promise<{ id: string } | null> => null),
    getStatus: jest.fn(async () => 'draft'),
    recomputeStatus: jest.fn(async () => 'posted'),
  };

  beforeEach(async () => {
    publishedTopics.length = 0;
    records.clear();
    seq = 0;
    postedLedgerEntries.length = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DeliveryService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: ShipmentService, useValue: shipmentsMock },
        { provide: FulfillmentService, useValue: fulfillmentMock },
        { provide: SalesOrdersService, useValue: salesOrdersMock },
        { provide: TreasuryService, useValue: treasuryMock },
        { provide: InventoryService, useValue: inventoryMock },
        { provide: AuditService, useValue: auditMock },
        { provide: EventBusService, useValue: eventsMock },
        { provide: CustomerLedgerService, useValue: customerLedgerMock },
        { provide: InvoiceService, useValue: invoicesMock },
      ],
    }).compile();
    service = moduleRef.get(DeliveryService);
  });

  it('recording a "delivered" outcome drives Shipment.transitionShipment("deliver") through its published contract', async () => {
    await service.recordOutcome('ship-1', 'delivered', null, 'driver-1');
    expect(shipmentsMock.transitionShipment).toHaveBeenCalledWith('ship-1', 'deliver', 'driver-1');
    expect(publishedTopics).toContain('delivery.completed');
  });

  it('recording a "failed" outcome drives Shipment.transitionShipment("fail_delivery") and includes the reason', async () => {
    await service.recordOutcome('ship-1', 'failed', 'Customer not home', 'driver-1');
    expect(shipmentsMock.transitionShipment).toHaveBeenCalledWith('ship-1', 'fail_delivery', 'driver-1');
    expect(publishedTopics).toContain('delivery.failed');
  });

  describe('Final inventory dispatch (CTO directive — reconcile the Preparation -> Shipping handoff, "no premature inventory deduction")', () => {
    it('on a "delivered" outcome, dispatches the order\'s reservations from wherever the goods actually currently sit (the custodian\'s warehouse, not the Fulfillment Order\'s original one)', async () => {
      await service.recordOutcome('ship-1', 'delivered', null, 'driver-1');
      expect(inventoryMock.fulfillReservationsForOrder).toHaveBeenCalledWith('so-1', 'wh-custody-1', 'driver-1');
    });

    it('falls back to the Fulfillment Order\'s own warehouse when no custodian ever handled the shipment (plain in-house delivery)', async () => {
      await service.recordOutcome('ship-no-custodian', 'delivered', null, 'driver-1');
      expect(inventoryMock.fulfillReservationsForOrder).toHaveBeenCalledWith('so-1', 'wh-1', 'driver-1');
    });

    it('never dispatches inventory on a failed/refused/returned outcome — the goods never reached the customer', async () => {
      await service.recordOutcome('ship-1', 'failed', 'Customer not home', 'driver-1');
      expect(inventoryMock.fulfillReservationsForOrder).not.toHaveBeenCalled();
    });
  });

  describe('recordCollection (CTO directive §7 — "Customer -> Driver/Shipping Company Custody -> Company Treasury")', () => {
    it('publishes collection.recorded as a first-class finance-ready event', async () => {
      await service.recordCollection('ship-1', '150.00', 'cash', 'driver-1');
      expect(publishedTopics).toContain('collection.recorded');
    });

    it('creates the collection with remittanceStatus "pending" by default', async () => {
      const collection = await service.recordCollection('ship-1', '150.00', 'cash', 'driver-1');
      expect(collection.remittanceStatus).toBe('pending');
    });

    it('posts the collected amount into the CUSTODY account immediately, when the shipment has a custodian', async () => {
      const collection = await service.recordCollection('ship-1', '150.00', 'cash', 'driver-1');
      expect(treasuryMock.cashIn).toHaveBeenCalledWith(
        'acct-custody-1',
        '150.00',
        'cust-1', // resolved via FulfillmentOrder -> SalesOrder -> Customer
        'so-1',
        'ship-1',
        'cod_collection_custody',
        'driver-1',
      );
      expect(collection.custodyAccountId).toBe('acct-custody-1');
      expect(collection.custodyTransactionId).toBeTruthy();
    });

    it('has no custody leg at all for a plain in-house delivery with no custodian', async () => {
      const collection = await service.recordCollection('ship-no-custodian', '90.00', 'cash', 'driver-1');
      expect(collection.custodyAccountId).toBeNull();
      expect(collection.custodyTransactionId).toBeNull();
      expect(treasuryMock.cashIn).not.toHaveBeenCalled();
    });

    it('REAL BUG FOUND AND FIXED (Shipping Screen Redesign directive §8/§13) — rejects a second collection for the same shipment, preventing a double-click from posting two Treasury cash-in entries for one real collection', async () => {
      await service.recordCollection('ship-1', '150.00', 'cash', 'driver-1');
      treasuryMock.cashIn.mockClear();
      await expect(service.recordCollection('ship-1', '150.00', 'cash', 'driver-1')).rejects.toBeInstanceOf(ConflictException);
      expect(treasuryMock.cashIn).not.toHaveBeenCalled();
    });
  });

  describe('remitCollection — Path 1: custody leg exists (CTO directive §6 — "DHL Custody -20,000 / Company Bank/Cash +20,000")', () => {
    it('transfers OUT of the custody account into the settlement account via TreasuryService.transfer — never a bare cashIn (which would double-count)', async () => {
      const collection = await service.recordCollection('ship-1', '150.00', 'cash', 'driver-1');
      const remitted = await service.remitCollection(collection.id, 'finance-1');

      expect(treasuryMock.transfer).toHaveBeenCalledWith(
        'acct-custody-1',
        'acct-settlement-1',
        '150.00',
        collection.id,
        'shipping_collection_settlement',
        'finance-1',
      );
      expect(treasuryMock.cashIn).toHaveBeenCalledTimes(1); // only the earlier custody-leg call, no second cashIn at remit time
      expect(remitted.remittanceStatus).toBe('remitted');
      expect(remitted.treasuryTransactionId).toBeTruthy();
      expect(remitted.remittedAt).not.toBeNull();
    });

    it('accepts an explicit treasuryAccountId, overriding the custodian\'s own settlement account', async () => {
      const collection = await service.recordCollection('ship-1', '150.00', 'cash', 'driver-1');
      await service.remitCollection(collection.id, 'finance-1', 'acct-explicit');
      expect(treasuryMock.transfer).toHaveBeenCalledWith('acct-custody-1', 'acct-explicit', '150.00', collection.id, expect.anything(), 'finance-1');
    });

    it('rejects remitting a collection that has already been remitted', async () => {
      const collection = await service.recordCollection('ship-1', '150.00', 'cash', 'driver-1');
      await service.remitCollection(collection.id, 'finance-1');
      await expect(service.remitCollection(collection.id, 'finance-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects when the custodian has no settlement account configured and none is supplied', async () => {
      const collection = await service.recordCollection('ship-no-settlement', '80.00', 'cash', 'driver-1');
      await expect(service.remitCollection(collection.id, 'finance-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException for an unknown collection id', async () => {
      await expect(service.remitCollection('no-such-id', 'finance-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remitCollection — Path 2: no custody leg (plain in-house delivery, original direct-cashIn behavior preserved)', () => {
    it('requires an explicit treasuryAccountId and posts a bare cashIn (no custody account exists to transfer out of)', async () => {
      const collection = await service.recordCollection('ship-no-custodian', '90.00', 'cash', 'driver-1');
      const remitted = await service.remitCollection(collection.id, 'finance-1', 'acct-driver-cash');

      expect(treasuryMock.cashIn).toHaveBeenCalledWith(
        'acct-driver-cash',
        '90.00',
        'cust-1',
        'so-1',
        collection.id,
        'shipping_collection_remittance',
        'finance-1',
      );
      expect(treasuryMock.transfer).not.toHaveBeenCalled();
      expect(remitted.remittanceStatus).toBe('remitted');
    });

    it('rejects with no treasuryAccountId supplied at all', async () => {
      const collection = await service.recordCollection('ship-no-custodian', '90.00', 'cash', 'driver-1');
      await expect(service.remitCollection(collection.id, 'finance-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('Customer Ledger bridge (Customer Financial Account / AR — CTO directive) — only at REMIT time, never at mere collection', () => {
    it('recordCollection alone posts NOTHING to the Customer Ledger — AR is only reduced once the money actually reaches a real Treasury account', async () => {
      await service.recordCollection('ship-1', '150.00', 'cash', 'driver-1');
      expect(postedLedgerEntries).toHaveLength(0);
    });

    it('remitCollection posts exactly one unapplied "cod_collection" credit entry when no invoice yet exists', async () => {
      const collection = await service.recordCollection('ship-1', '150.00', 'cash', 'driver-1');
      await service.remitCollection(collection.id, 'finance-1');

      expect(postedLedgerEntries).toHaveLength(1);
      expect(postedLedgerEntries[0]).toMatchObject({
        customerId: 'cust-1',
        entryType: 'cod_collection',
        direction: 'credit',
        amount: '150.00',
        salesOrderId: 'so-1',
        invoiceId: null,
        shipmentId: 'ship-1',
      });
      expect(invoicesMock.recomputeStatus).not.toHaveBeenCalled();
    });

    it('links directly to an already-posted invoice for the same order and recomputes its status', async () => {
      invoicesMock.findOpenInvoiceForOrder.mockResolvedValueOnce({ id: 'inv-1' });
      invoicesMock.getStatus.mockResolvedValueOnce('posted');

      const collection = await service.recordCollection('ship-1', '150.00', 'cash', 'driver-1');
      await service.remitCollection(collection.id, 'finance-1');

      expect(postedLedgerEntries[0]).toMatchObject({ invoiceId: 'inv-1' });
      expect(invoicesMock.recomputeStatus).toHaveBeenCalledWith('inv-1', 'finance-1');
    });

    it('also bridges Path 2 (no custody leg, plain in-house delivery)', async () => {
      const collection = await service.recordCollection('ship-no-custodian', '90.00', 'cash', 'driver-1');
      await service.remitCollection(collection.id, 'finance-1', 'acct-driver-cash');

      expect(postedLedgerEntries).toHaveLength(1);
      expect(postedLedgerEntries[0]).toMatchObject({ entryType: 'cod_collection', direction: 'credit', amount: '90.00', shipmentId: 'ship-no-custodian' });
    });
  });

  describe('listPendingRemittances', () => {
    it('returns only collections still pending, excluding already-remitted ones', async () => {
      const c1 = await service.recordCollection('ship-1', '100.00', 'cash', 'driver-1');
      const c2 = await service.recordCollection('ship-2', '50.00', 'cash', 'driver-1');
      await service.remitCollection(c1.id, 'finance-1');

      const pending = await service.listPendingRemittances();
      expect(pending.map((c) => c.id)).toEqual([c2.id]);
    });
  });
});
