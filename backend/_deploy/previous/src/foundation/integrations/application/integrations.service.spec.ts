import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { IntegrationConnector } from '../infrastructure/integration-connector.entity';
import { IntegrationCredential } from '../infrastructure/integration-credential.entity';
import { IntegrationProductMapping } from '../infrastructure/integration-product-mapping.entity';
import { IntegrationSyncLog } from '../infrastructure/integration-sync-log.entity';
import { CredentialCipherService } from './credential-cipher.service';
import { QrStoreConnector } from './connectors/qr-store.connector';
import { AuditService } from '../../audit/audit.service';
import { EventBusService } from '../../events/event-bus.service';
import { ProductsService } from '../../../domains/commerce/application/products.service';
import { CustomersService } from '../../../domains/crm/application/customers.service';
import { SalesOrdersService } from '../../../domains/sales-orders/application/sales-orders.service';
import { InventoryService } from '../../../domains/inventory-warehouse/application/inventory.service';

/**
 * Gap: CTO handover directive "Daii <-> QR Store Integration & Pairing
 * Architecture". Covers the properties the directive itself calls out as
 * non-negotiable: encrypted-at-rest credentials (never plaintext at
 * rest), SKU-based reconciliation (never by name), and idempotent order
 * intake (a retried external order id never creates a second Sales
 * Order).
 */
describe('IntegrationsService', () => {
  let service: IntegrationsService;
  const connectors = new Map<string, IntegrationConnector>();
  const credentials = new Map<string, IntegrationCredential>();
  const mappings = new Map<string, IntegrationProductMapping>();
  const syncLogs: IntegrationSyncLog[] = [];
  let idSeq = 0;

  function connectorRepo() {
    return {
      create: jest.fn((data: Partial<IntegrationConnector>) => ({ id: `conn-${++idSeq}`, ...data }) as IntegrationConnector),
      save: jest.fn(async (c: Partial<IntegrationConnector>) => {
        const saved = { ...(connectors.get((c as IntegrationConnector).id) ?? {}), ...c } as IntegrationConnector;
        connectors.set(saved.id, saved);
        return saved;
      }),
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => connectors.get(where.id) ?? null),
      find: jest.fn(async () => [...connectors.values()]),
    };
  }
  function credentialRepo() {
    return {
      create: jest.fn((data: Partial<IntegrationCredential>) => ({ id: `cred-${++idSeq}`, ...data }) as IntegrationCredential),
      save: jest.fn(async (c: IntegrationCredential) => {
        credentials.set(c.id, c);
        return c;
      }),
      findOne: jest.fn(async ({ where }: { where: { connectorId: string; revoked: boolean } }) => {
        const matches = [...credentials.values()].filter((c) => c.connectorId === where.connectorId && c.revoked === where.revoked);
        return matches.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))[0] ?? null;
      }),
    };
  }
  function mappingRepo() {
    return {
      create: jest.fn((data: Partial<IntegrationProductMapping>) => ({ id: `map-${++idSeq}`, ...data }) as IntegrationProductMapping),
      save: jest.fn(async (data: Partial<IntegrationProductMapping>) => {
        const saved = { id: data.id ?? `map-${++idSeq}`, ...data } as IntegrationProductMapping;
        mappings.set(saved.id, saved);
        return saved;
      }),
      findOne: jest.fn(async ({ where }: { where: Partial<IntegrationProductMapping> }) =>
        [...mappings.values()].find((m) =>
          Object.entries(where).every(([k, v]) => (m as unknown as Record<string, unknown>)[k] === v),
        ) ?? null,
      ),
      find: jest.fn(async ({ where }: { where: { connectorId: string } }) => [...mappings.values()].filter((m) => m.connectorId === where.connectorId)),
    };
  }
  function syncLogRepo() {
    return {
      create: jest.fn((data: Partial<IntegrationSyncLog>) => ({ id: `log-${++idSeq}`, createdAt: new Date(), ...data }) as IntegrationSyncLog),
      save: jest.fn(async (l: IntegrationSyncLog) => {
        syncLogs.push(l);
        return l;
      }),
      findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const matches = syncLogs.filter((l) => Object.entries(where).every(([k, v]) => (l as unknown as Record<string, unknown>)[k] === v));
        return matches.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))[0] ?? null;
      }),
      find: jest.fn(async ({ where }: { where: { connectorId: string } }) => syncLogs.filter((l) => l.connectorId === where.connectorId)),
    };
  }

  const getRepositoryMock = jest.fn((entity: unknown) => {
    if (entity === IntegrationConnector) return connectorRepo();
    if (entity === IntegrationCredential) return credentialRepo();
    if (entity === IntegrationProductMapping) return mappingRepo();
    return syncLogRepo();
  });
  const queryMock = jest.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('UPDATE integration_credentials')) {
      const [connectorId] = params as [string];
      for (const c of credentials.values()) if (c.connectorId === connectorId) c.revoked = true;
    }
    return [];
  });
  const dataSourceMock = {
    getRepository: getRepositoryMock,
    query: queryMock,
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn({ getRepository: getRepositoryMock, query: queryMock })),
  };

  const auditMock = { record: jest.fn(async () => undefined) };
  const eventsMock = { subscribe: jest.fn(), publish: jest.fn(async () => undefined), dispatchPending: jest.fn(async () => ({ dispatched: 0, failed: 0 })) };

  const daiiProducts: Record<string, { id: string; sku: string; name: string; unitPrice: string; status: 'draft' | 'active' | 'discontinued' }> = {
    'prod-1': { id: 'prod-1', sku: 'SKU-1', name: 'Widget', unitPrice: '10.00', status: 'active' },
  };
  const productsMock = {
    getProductSnapshot: jest.fn(async (id: string) => daiiProducts[id] ?? null),
    listAllProducts: jest.fn(async () => Object.values(daiiProducts)),
  };

  const daiiCustomers = new Map<string, { id: string; name: string; phone: string | null }>();
  const customersMock = {
    findByPhone: jest.fn(async (phone: string) => [...daiiCustomers.values()].find((c) => c.phone === phone) ?? null),
    createCustomer: jest.fn(async (input: { name: string; phone?: string | null }) => {
      const c = { id: `cust-${++idSeq}`, name: input.name, phone: input.phone ?? null };
      daiiCustomers.set(c.id, c);
      return c;
    }),
    assignSalesRep: jest.fn(async () => undefined),
  };

  const salesOrders = new Map<string, { id: string; orderNumber: string; status: string }>();
  const salesOrdersMock = {
    createOrder: jest.fn(async (customerId: string, salesRepUserId: string, lines: unknown[]) => {
      const order = { id: `so-${++idSeq}`, orderNumber: `SO-2026-${idSeq}`, status: 'draft' };
      salesOrders.set(order.id, order);
      return order;
    }),
    getOrderStatus: jest.fn(async (id: string) => salesOrders.get(id)?.status ?? 'draft'),
  };

  const inventoryMock = {
    getTotalAvailable: jest.fn(async () => 42),
    listWarehouses: jest.fn(async () => [{ id: 'wh-default', code: 'MAIN', name: 'Main Warehouse', status: 'active' }]),
  };

  const qrConnectorMock = {
    testConnection: jest.fn(
      async (): Promise<{ ok: boolean; identity?: { externalStoreId: string; storeName: string }; error?: string }> => ({
        ok: true,
        identity: { externalStoreId: 'store-1', storeName: 'Demo Store' },
      }),
    ),
    publishProduct: jest.fn(async () => ({ externalProductId: 'ext-prod-1' })),
    publishAvailability: jest.fn(async () => undefined),
    publishOrderStatus: jest.fn(async () => undefined),
  };

  beforeEach(async () => {
    connectors.clear();
    credentials.clear();
    mappings.clear();
    syncLogs.length = 0;
    daiiCustomers.clear();
    salesOrders.clear();
    idSeq = 0;
    jest.clearAllMocks();
    qrConnectorMock.testConnection.mockResolvedValue({ ok: true, identity: { externalStoreId: 'store-1', storeName: 'Demo Store' } });

    const moduleRef = await Test.createTestingModule({
      providers: [
        IntegrationsService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: AuditService, useValue: auditMock },
        {
          provide: CredentialCipherService,
          useValue: new CredentialCipherService({ integrationEncryptionKey: 'test-only-32-character-key-value' } as never),
        },
        { provide: EventBusService, useValue: eventsMock },
        { provide: ProductsService, useValue: productsMock },
        { provide: CustomersService, useValue: customersMock },
        { provide: SalesOrdersService, useValue: salesOrdersMock },
        { provide: InventoryService, useValue: inventoryMock },
        { provide: QrStoreConnector, useValue: qrConnectorMock },
      ],
    }).compile();
    service = moduleRef.get(IntegrationsService);
  });

  async function createTestConnector() {
    return service.createConnector('qr_store', 'Main QR Store', { apiUrl: 'https://qr.example.test', systemUserId: 'user-system-1' }, 'admin-1');
  }

  it('rejects an unknown connector type', async () => {
    await expect(service.createConnector('shipping_x', 'X', { systemUserId: 'u' }, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires config.systemUserId on creation', async () => {
    await expect(service.createConnector('qr_store', 'X', {}, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('pairs a connector and encrypts the credential at rest (never stores plaintext)', async () => {
    const connector = await createTestConnector();
    await service.pairConnector(connector.id, 'super-secret-pairing-token', 'admin-1');
    const stored = [...credentials.values()].find((c) => c.connectorId === connector.id && !c.revoked)!;
    expect(stored.encryptedValue).not.toContain('super-secret-pairing-token');
  });

  it('revokes the prior credential when pairing again (rotation)', async () => {
    const connector = await createTestConnector();
    await service.pairConnector(connector.id, 'first-pairing-token-12345', 'admin-1');
    await service.pairConnector(connector.id, 'second-pairing-token-6789', 'admin-1');
    const active = [...credentials.values()].filter((c) => c.connectorId === connector.id && !c.revoked);
    expect(active).toHaveLength(1);
  });

  it('tests the connection and transitions the connector to connected on success', async () => {
    const connector = await createTestConnector();
    await service.pairConnector(connector.id, 'a-real-pairing-token-123', 'admin-1');
    const result = await service.testConnection(connector.id, 'admin-1');
    expect(result.ok).toBe(true);
    expect((await service.getConnector(connector.id)).status).toBe('connected');
  });

  it('transitions to error on a failed connection test', async () => {
    qrConnectorMock.testConnection.mockResolvedValueOnce({ ok: false, error: 'network unreachable' });
    const connector = await createTestConnector();
    await service.pairConnector(connector.id, 'a-real-pairing-token-123', 'admin-1');
    await service.testConnection(connector.id, 'admin-1');
    expect((await service.getConnector(connector.id)).status).toBe('error');
  });

  it('reconciles by SKU, never by name (Gap: directive §8/§14)', async () => {
    const connector = await createTestConnector();
    const report = await service.proposeReconciliation(connector.id, [
      { externalProductId: 'ext-1', sku: 'SKU-1', name: 'Totally Different Display Name' },
      { externalProductId: 'ext-2', sku: 'SKU-UNKNOWN', name: 'Widget' }, // same NAME as prod-1, different SKU — must NOT match
    ]);
    expect(report.matched).toEqual([{ daiiProductId: 'prod-1', sku: 'SKU-1', externalProductId: 'ext-1' }]);
    expect(report.newInExternal).toEqual([{ externalProductId: 'ext-2', sku: 'SKU-UNKNOWN', name: 'Widget' }]);
  });

  it('confirmReconciliation writes real mappings', async () => {
    const connector = await createTestConnector();
    await service.confirmReconciliation(connector.id, [{ daiiProductId: 'prod-1', externalProductId: 'ext-1' }], 'admin-1');
    const list = await service.listMappings(connector.id);
    expect(list).toHaveLength(1);
    expect(list[0].externalProductId).toBe('ext-1');
  });

  it('publishProduct never throws when the connector adapter fails — logs failed instead', async () => {
    qrConnectorMock.publishProduct.mockRejectedValueOnce(new Error('QR is down'));
    const connector = await createTestConnector();
    await service.pairConnector(connector.id, 'a-real-pairing-token-123', 'admin-1');
    await service.testConnection(connector.id, 'admin-1');
    await expect(service.publishProduct(connector.id, 'prod-1', 'admin-1')).resolves.toBeUndefined();
    const logs = await service.listSyncLogs(connector.id);
    expect(logs.some((l) => l.eventType === 'product.published' && l.status === 'failed')).toBe(true);
  });

  describe('receiveOrder (Gap: directive §16 idempotency)', () => {
    async function setUpConnectedConnectorWithMapping() {
      const connector = await createTestConnector();
      await service.pairConnector(connector.id, 'a-real-pairing-token-123', 'admin-1');
      await service.testConnection(connector.id, 'admin-1');
      await service.createMapping(connector.id, 'prod-1', 'ext-prod-1', 'admin-1');
      return connector;
    }

    it('creates a new customer + Sales Order for a first-time order', async () => {
      const connector = await setUpConnectedConnectorWithMapping();
      const result = await service.receiveOrder(
        connector.id,
        'qr-order-001',
        { name: 'Aylin Cafe', phone: '+201000000001' },
        [{ externalProductId: 'ext-prod-1', quantity: 2 }],
        null,
      );
      expect(result.duplicate).toBe(false);
      expect(salesOrdersMock.createOrder).toHaveBeenCalledTimes(1);
      expect(customersMock.assignSalesRep).toHaveBeenCalledWith(expect.any(String), 'user-system-1', 'primary', null);
    });

    it('a retried identical externalOrderId returns the SAME Sales Order, never creates a second one', async () => {
      const connector = await setUpConnectedConnectorWithMapping();
      const first = await service.receiveOrder(
        connector.id,
        'qr-order-002',
        { name: 'Hi Risk Cafe', phone: '+201000000002' },
        [{ externalProductId: 'ext-prod-1', quantity: 1 }],
        null,
      );
      const second = await service.receiveOrder(
        connector.id,
        'qr-order-002',
        { name: 'Hi Risk Cafe', phone: '+201000000002' },
        [{ externalProductId: 'ext-prod-1', quantity: 1 }],
        null,
      );
      expect(second.duplicate).toBe(true);
      expect(second.daiiSalesOrderId).toBe(first.daiiSalesOrderId);
      expect(salesOrdersMock.createOrder).toHaveBeenCalledTimes(1); // not 2
    });

    it('reuses an existing Daii customer matched by phone, never duplicating', async () => {
      const connector = await setUpConnectedConnectorWithMapping();
      await service.receiveOrder(connector.id, 'qr-order-003', { name: 'Cove Cafe', phone: '+201000000003' }, [{ externalProductId: 'ext-prod-1', quantity: 1 }], null);
      await service.receiveOrder(connector.id, 'qr-order-004', { name: 'Cove Cafe (renamed)', phone: '+201000000003' }, [{ externalProductId: 'ext-prod-1', quantity: 1 }], null);
      expect(customersMock.createCustomer).toHaveBeenCalledTimes(1);
    });

    it('rejects the whole order when any line has no product mapping — writes nothing', async () => {
      const connector = await setUpConnectedConnectorWithMapping();
      await expect(
        service.receiveOrder(connector.id, 'qr-order-005', { name: 'X', phone: '+201000000005' }, [{ externalProductId: 'ext-UNMAPPED', quantity: 1 }], null),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(salesOrdersMock.createOrder).not.toHaveBeenCalled();
    });

    it('rejects an order for a disconnected connector', async () => {
      const connector = await createTestConnector(); // status stays 'pending' — never tested/connected
      await expect(
        service.receiveOrder(connector.id, 'qr-order-006', { name: 'X', phone: '+201000000006' }, [{ externalProductId: 'ext-prod-1', quantity: 1 }], null),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
