import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { Product } from '../infrastructure/product.entity';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';

describe('ProductsService', () => {
  let service: ProductsService;
  const products = new Map<string, Product>();
  let idSeq = 0;

  const repoMock = {
    findOne: jest.fn(async ({ where }: { where: { id?: string; sku?: string } }) => {
      for (const p of products.values()) {
        if (where.id && p.id === where.id) return p;
        if (where.sku && p.sku === where.sku) return p;
      }
      return null;
    }),
    find: jest.fn(async ({ where }: { where: { status: string } }) =>
      [...products.values()].filter((p) => p.status === where.status),
    ),
    create: jest.fn((data: Partial<Product>) => ({ id: `prod-${++idSeq}`, ...data }) as Product),
    save: jest.fn(async (p: Product) => {
      products.set(p.id, p);
      return p;
    }),
  };

  const dataSourceMock = {
    getRepository: jest.fn(() => repoMock),
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn({ getRepository: () => repoMock })),
  };
  const auditMock = { record: jest.fn(async () => undefined) };
  const eventsMock = { publish: jest.fn(async () => undefined), dispatchPending: jest.fn(async () => ({ dispatched: 0, failed: 0 })) };

  beforeEach(async () => {
    products.clear();
    idSeq = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: AuditService, useValue: auditMock },
        { provide: EventBusService, useValue: eventsMock },
      ],
    }).compile();
    service = moduleRef.get(ProductsService);
  });

  it('publishes commerce.product.created and dispatches pending events', async () => {
    const product = await service.createProduct('SKU-1', 'Widget', '19.99', 'actor-1');
    expect(eventsMock.publish).toHaveBeenCalledWith(
      expect.anything(),
      'commerce.product.created',
      expect.objectContaining({ productId: product.id, sku: 'SKU-1' }),
    );
    expect(eventsMock.dispatchPending).toHaveBeenCalled();
  });

  it('creates a product in draft status', async () => {
    const product = await service.createProduct('SKU-1', 'Widget', '19.99', 'actor-1');
    expect(product.status).toBe('draft');
  });

  it('rejects a duplicate SKU', async () => {
    await service.createProduct('SKU-1', 'Widget', '19.99', 'actor-1');
    await expect(service.createProduct('SKU-1', 'Other', '9.99', 'actor-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('transitions draft -> active and lists it in the active catalog', async () => {
    const product = await service.createProduct('SKU-1', 'Widget', '19.99', 'actor-1');
    await service.setStatus(product.id, 'active', 'actor-1');
    const active = await service.listActiveProducts();
    expect(active.map((p) => p.id)).toContain(product.id);
  });

  it('rejects reactivating a discontinued product', async () => {
    const product = await service.createProduct('SKU-1', 'Widget', '19.99', 'actor-1');
    await service.setStatus(product.id, 'active', 'actor-1');
    await service.setStatus(product.id, 'discontinued', 'actor-1');
    await expect(service.setStatus(product.id, 'active', 'actor-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws for an unknown product id', async () => {
    await expect(service.getProduct('no-such-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates a product\'s price and publishes commerce.product.price_changed', async () => {
    const product = await service.createProduct('SKU-1', 'Widget', '19.99', 'actor-1');
    eventsMock.publish.mockClear();
    const updated = await service.updatePrice(product.id, '24.99', 'actor-1');
    expect(updated.unitPrice).toBe('24.99');
    expect(eventsMock.publish).toHaveBeenCalledWith(
      expect.anything(),
      'commerce.product.price_changed',
      expect.objectContaining({ productId: product.id, unitPrice: '24.99' }),
    );
  });

  it('rejects a negative price', async () => {
    const product = await service.createProduct('SKU-1', 'Widget', '19.99', 'actor-1');
    await expect(service.updatePrice(product.id, '-5.00', 'actor-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('updates a product\'s name and publishes commerce.product.name_changed', async () => {
    const product = await service.createProduct('SKU-1', 'Widget', '19.99', 'actor-1');
    eventsMock.publish.mockClear();
    const updated = await service.updateName(product.id, 'Deluxe Widget', 'actor-1');
    expect(updated.name).toBe('Deluxe Widget');
    expect(eventsMock.publish).toHaveBeenCalledWith(
      expect.anything(),
      'commerce.product.name_changed',
      expect.objectContaining({ productId: product.id, name: 'Deluxe Widget' }),
    );
  });

  it('rejects an empty name', async () => {
    const product = await service.createProduct('SKU-1', 'Widget', '19.99', 'actor-1');
    await expect(service.updateName(product.id, '   ', 'actor-1')).rejects.toBeInstanceOf(ConflictException);
  });
});
