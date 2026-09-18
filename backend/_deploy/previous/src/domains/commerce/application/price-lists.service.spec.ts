import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PriceListsService } from './price-lists.service';
import { PriceList } from '../infrastructure/price-list.entity';
import { PriceListItem } from '../infrastructure/price-list-item.entity';
import { ProductsService } from './products.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';

/** Gap G-3 — Price List master/items, effective-price resolution, and the Excel import path. */
describe('PriceListsService', () => {
  let service: PriceListsService;
  const priceLists = new Map<string, PriceList>();
  const items = new Map<string, PriceListItem>();
  let idSeq = 0;

  const priceListRepoMock = () => ({
    create: jest.fn((data: Partial<PriceList>) => ({ id: `pl-${++idSeq}`, ...data }) as PriceList),
    save: jest.fn(async (pl: PriceList) => {
      priceLists.set(pl.id, pl);
      return pl;
    }),
    findOne: jest.fn(async ({ where }: { where: { id?: string; role?: string | null } }) => {
      if (where.id !== undefined) return priceLists.get(where.id) ?? null;
      if (where.role !== undefined) return [...priceLists.values()].find((pl) => pl.role === where.role) ?? null;
      return null;
    }),
    find: jest.fn(async () => [...priceLists.values()]),
  });

  const itemRepoMock = () => ({
    create: jest.fn((data: Partial<PriceListItem>) => ({ id: `item-${++idSeq}`, ...data }) as PriceListItem),
    save: jest.fn(async (data: Partial<PriceListItem>) => {
      const saved = { ...data } as PriceListItem;
      items.set(saved.id, saved);
      return saved;
    }),
    findOne: jest.fn(async ({ where }: { where: { id?: string; priceListId?: string; productId?: string } }) => {
      for (const item of items.values()) {
        if (where.id && item.id !== where.id) continue;
        if (where.priceListId && item.priceListId !== where.priceListId) continue;
        if (where.productId && item.productId !== where.productId) continue;
        return item;
      }
      return null;
    }),
    find: jest.fn(async ({ where }: { where: { priceListId: string } }) =>
      [...items.values()].filter((i) => i.priceListId === where.priceListId),
    ),
    remove: jest.fn(async (item: PriceListItem) => {
      items.delete(item.id);
      return item;
    }),
  });

  const getRepositoryMock = jest.fn((entity: unknown) => (entity === PriceList ? priceListRepoMock() : itemRepoMock()));
  const dataSourceMock = { getRepository: getRepositoryMock };

  const numberingMock = { getNextNumber: jest.fn(async () => 'PL-000001') };
  const auditMock = { record: jest.fn(async () => undefined) };
  const eventsMock = { subscribe: jest.fn() };
  const productsMock = {
    getProductSnapshot: jest.fn(async (id: string) =>
      id === 'missing-product' ? null : { id, sku: `SKU-${id}`, name: `Product ${id}`, unitPrice: '10.00', status: 'active' },
    ),
    getProductSnapshotBySku: jest.fn(async (sku: string) =>
      sku === 'UNKNOWN-SKU' ? null : { id: `prod-for-${sku}`, sku, name: `Product for ${sku}`, unitPrice: '10.00', status: 'active' },
    ),
  };

  beforeEach(async () => {
    priceLists.clear();
    items.clear();
    idSeq = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PriceListsService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: NumberingService, useValue: numberingMock },
        { provide: AuditService, useValue: auditMock },
        { provide: ProductsService, useValue: productsMock },
        { provide: EventBusService, useValue: eventsMock },
      ],
    }).compile();
    service = moduleRef.get(PriceListsService);
  });

  it('creates a price list with a Numbering-issued code, active by default', async () => {
    const pl = await service.createPriceList('Wholesale Tier', 'actor-1');
    expect(pl.code).toBe('PL-000001');
    expect(pl.status).toBe('active');
  });

  it('adds an item, then updates it in place on a second upsert (no duplicate)', async () => {
    const pl = await service.createPriceList('Wholesale Tier', 'actor-1');
    await service.upsertItem(pl.id, 'prod-1', '20.00', 'actor-1');
    await service.upsertItem(pl.id, 'prod-1', '18.50', 'actor-1');
    const list = await service.listItems(pl.id);
    expect(list).toHaveLength(1);
    expect(list[0].price).toBe('18.50');
  });

  it('rejects a negative item price', async () => {
    const pl = await service.createPriceList('Wholesale Tier', 'actor-1');
    await expect(service.upsertItem(pl.id, 'prod-1', '-5.00', 'actor-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects an item for an unknown product', async () => {
    const pl = await service.createPriceList('Wholesale Tier', 'actor-1');
    await expect(service.upsertItem(pl.id, 'missing-product', '10.00', 'actor-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getOverridePrice returns the item price for an active list with a matching item', async () => {
    const pl = await service.createPriceList('Wholesale Tier', 'actor-1');
    await service.upsertItem(pl.id, 'prod-1', '20.00', 'actor-1');
    expect(await service.getOverridePrice(pl.id, 'prod-1')).toBe('20.00');
  });

  it('getOverridePrice returns null for a product not in the list (fall back to base price)', async () => {
    const pl = await service.createPriceList('Wholesale Tier', 'actor-1');
    expect(await service.getOverridePrice(pl.id, 'prod-not-listed')).toBeNull();
  });

  it('getOverridePrice returns null once the list is deactivated, even with a matching item', async () => {
    const pl = await service.createPriceList('Wholesale Tier', 'actor-1');
    await service.upsertItem(pl.id, 'prod-1', '20.00', 'actor-1');
    await service.setStatus(pl.id, 'inactive', 'actor-1');
    expect(await service.getOverridePrice(pl.id, 'prod-1')).toBeNull();
  });

  it('getOverridePrice returns null for an unknown price list id (never throws)', async () => {
    expect(await service.getOverridePrice('no-such-list', 'prod-1')).toBeNull();
  });

  it('removes an item', async () => {
    const pl = await service.createPriceList('Wholesale Tier', 'actor-1');
    const item = await service.upsertItem(pl.id, 'prod-1', '20.00', 'actor-1');
    await service.removeItem(pl.id, item.id, 'actor-1');
    expect(await service.listItems(pl.id)).toHaveLength(0);
  });

  it('imports rows by SKU, rejecting an unknown SKU without blocking the valid rows', async () => {
    const pl = await service.createPriceList('Wholesale Tier', 'actor-1');
    const result = await service.importItemRows(
      pl.id,
      [
        { sku: 'SKU-A', price: '15.00' },
        { sku: 'UNKNOWN-SKU', price: '10.00' },
      ],
      'actor-1',
    );
    expect(result.succeededCount).toBe(1);
    expect(result.rejected).toEqual([{ row: 3, errors: ['Product with code "UNKNOWN-SKU" was not found.'] }]);
  });

  describe('Post-v1.0.2 Hotfix 3 — Price List priority chain (Customer -> Main -> General)', () => {
    it('subscribes to commerce.product.created on module init', () => {
      service.onModuleInit();
      expect(eventsMock.subscribe).toHaveBeenCalledWith('commerce.product.created', expect.any(Function));
    });

    it('the commerce.product.created handler adds the new product to the General list at its own price, auto-creating the General list on first use', async () => {
      service.onModuleInit();
      const handler = eventsMock.subscribe.mock.calls[0][1] as (payload: Record<string, unknown>) => Promise<void>;
      await handler({ productId: 'prod-new', sku: 'SKU-new', name: 'New Product' });

      const general = [...priceLists.values()].find((pl) => pl.role === 'general');
      expect(general).toBeDefined();
      expect(await service.getOverridePrice(general!.id, 'prod-new')).toBe('10.00'); // productsMock's fixed unitPrice
    });

    it('the commerce.product.created handler reuses the SAME General list across multiple products, never creating a second one', async () => {
      service.onModuleInit();
      const handler = eventsMock.subscribe.mock.calls[0][1] as (payload: Record<string, unknown>) => Promise<void>;
      await handler({ productId: 'prod-a' });
      await handler({ productId: 'prod-b' });
      const generalLists = [...priceLists.values()].filter((pl) => pl.role === 'general');
      expect(generalLists).toHaveLength(1);
    });

    it('setRole marks a list as Main', async () => {
      const pl = await service.createPriceList('Q1 Prices', 'actor-1');
      const updated = await service.setRole(pl.id, 'main', 'actor-1');
      expect(updated.role).toBe('main');
    });

    it('setRole auto-clears the PREVIOUS Main when a different list is set as Main (singleton, no separate unset step needed)', async () => {
      const first = await service.createPriceList('Old Main', 'actor-1');
      const second = await service.createPriceList('New Main', 'actor-1');
      await service.setRole(first.id, 'main', 'actor-1');
      await service.setRole(second.id, 'main', 'actor-1');

      const refreshedFirst = await service.getPriceList(first.id);
      const refreshedSecond = await service.getPriceList(second.id);
      expect(refreshedFirst.role).toBeNull();
      expect(refreshedSecond.role).toBe('main');
    });

    it('setRole(null) clears a list\'s role', async () => {
      const pl = await service.createPriceList('Q1 Prices', 'actor-1');
      await service.setRole(pl.id, 'main', 'actor-1');
      const cleared = await service.setRole(pl.id, null, 'actor-1');
      expect(cleared.role).toBeNull();
    });

    it('resolvePrice: customer list wins when it has an override, even if a Main list also has one', async () => {
      const customerList = await service.createPriceList('Customer List', 'actor-1');
      await service.upsertItem(customerList.id, 'prod-1', '5.00', 'actor-1');
      const mainList = await service.createPriceList('Main List', 'actor-1');
      await service.setRole(mainList.id, 'main', 'actor-1');
      await service.upsertItem(mainList.id, 'prod-1', '7.00', 'actor-1');

      const resolved = await service.resolvePrice(customerList.id, 'prod-1');
      expect(resolved).toEqual({ price: '5.00', priceListId: customerList.id });
    });

    it('resolvePrice: falls back to Main when the customer has no list', async () => {
      const mainList = await service.createPriceList('Main List', 'actor-1');
      await service.setRole(mainList.id, 'main', 'actor-1');
      await service.upsertItem(mainList.id, 'prod-1', '7.00', 'actor-1');

      const resolved = await service.resolvePrice(null, 'prod-1');
      expect(resolved).toEqual({ price: '7.00', priceListId: mainList.id });
    });

    it('resolvePrice: falls back to Main when the customer list exists but has no override for this product', async () => {
      const customerList = await service.createPriceList('Customer List', 'actor-1');
      const mainList = await service.createPriceList('Main List', 'actor-1');
      await service.setRole(mainList.id, 'main', 'actor-1');
      await service.upsertItem(mainList.id, 'prod-1', '7.00', 'actor-1');

      const resolved = await service.resolvePrice(customerList.id, 'prod-1');
      expect(resolved).toEqual({ price: '7.00', priceListId: mainList.id });
    });

    it('resolvePrice: falls back all the way to General when neither customer nor Main has an override', async () => {
      service.onModuleInit();
      const handler = eventsMock.subscribe.mock.calls[0][1] as (payload: Record<string, unknown>) => Promise<void>;
      await handler({ productId: 'prod-1' }); // seeds the General list with prod-1 @ 10.00 (productsMock fixture)

      const resolved = await service.resolvePrice(null, 'prod-1');
      expect(resolved.price).toBe('10.00');
      const general = [...priceLists.values()].find((pl) => pl.role === 'general');
      expect(resolved.priceListId).toBe(general!.id);
    });

    it('resolvePrice: returns a null price/priceListId when nothing in any tier has an override — caller falls back to the product\'s own base price', async () => {
      const resolved = await service.resolvePrice(null, 'prod-not-anywhere');
      expect(resolved).toEqual({ price: null, priceListId: null });
    });
  });
});
