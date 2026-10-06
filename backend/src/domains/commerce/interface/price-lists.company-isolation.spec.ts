import { randomUUID } from 'crypto';
import { ProductsService } from '../application/products.service';
import { PriceListsService } from '../application/price-lists.service';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * Real-Postgres proof that `price-lists.controller.ts`'s reads are genuinely
 * Company-scoped after this retrofit — two real, separately provisioned
 * Company databases, each with its own distinct product, price list, and
 * price-list item, never mocked.
 *
 * `listItems`/`resolvePrice` are the sharpest possible proof here: both call
 * into `ProductsService.getProductSnapshot(productId, manager)` internally —
 * if the retrofit failed to thread `manager` all the way through that nested
 * call, the lookup would silently fall back to the ambient (Platform)
 * connection, which has no seeded product data at all, and the assertions
 * below would fail closed (wrong/missing data), never leak Company B's data
 * into Company A's response.
 *
 * `PriceListsService`'s own dependencies beyond `DataSource`/`ProductsService`
 * (`NumberingService`, `AuditService`, `EventBusService`) are never invoked
 * by the read-only methods this test exercises (`listPriceLists`,
 * `getPriceList`, `listItems`, `resolvePrice`) — inert stand-ins are safe
 * here, same precedent as `products.company-isolation.spec.ts`.
 */
describe('PriceListsController Area 21 retrofit — real-Postgres Company isolation (2026-09-27)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let productsService: ProductsService;
  let priceListsService: PriceListsService;

  const seeded: Record<'A' | 'B', { productId: string; priceListId: string; itemPrice: string }> = {
    A: { productId: '', priceListId: '', itemPrice: '15.00' },
    B: { productId: '', priceListId: '', itemPrice: '25.00' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', sku: string, priceListCode: string) {
    const ds = await h.connections.getDataSource(companyId);
    const productId = randomUUID();
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'10.00','active')`, [
      productId,
      sku,
      `${sku} Product`,
    ]);

    const priceListId = randomUUID();
    await ds.query(`INSERT INTO "price_lists" ("id","code","name","status","role") VALUES ($1,$2,$3,'active','main')`, [
      priceListId,
      priceListCode,
      `${priceListCode} List`,
    ]);

    await ds.query(`INSERT INTO "price_list_items" ("id","priceListId","productId","price") VALUES ($1,$2,$3,$4)`, [
      randomUUID(),
      priceListId,
      productId,
      seeded[key].itemPrice,
    ]);

    seeded[key].productId = productId;
    seeded[key].priceListId = priceListId;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'price_lists_isolation', extraCompanyTags: ['sales'] });
    await seedCompanyData(h.companyAId, 'A', 'SKU-PL-A', 'PL-A-001');
    await seedCompanyData(h.companyBId, 'B', 'SKU-PL-B', 'PL-B-001');

    productsService = new ProductsService(h.controlPlane, {} as never, {} as never);
    priceListsService = new PriceListsService(h.controlPlane, {} as never, {} as never, productsService, {} as never);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("listPriceLists via Company A resolves Company A's own list, plus its own migration-seeded General list — never Company B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const lists = await priceListsService.listPriceLists(dsA.manager);
    expect(lists.map((l) => l.code).sort()).toEqual(['PL-A-001', 'PL-GENERAL']);
  });

  it("listPriceLists via Company B resolves Company B's own list, plus its own migration-seeded General list — no leakage of Company A's lists", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const lists = await priceListsService.listPriceLists(dsB.manager);
    expect(lists.map((l) => l.code).sort()).toEqual(['PL-B-001', 'PL-GENERAL']);
  });

  it("getPriceList for Company A's own list id succeeds via Company A's manager", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const list = await priceListsService.getPriceList(seeded.A.priceListId, dsA.manager);
    expect(list.code).toBe('PL-A-001');
  });

  it("getPriceList for Company A's list id 404s via Company B's manager — the row genuinely does not exist in Company B's own database", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(priceListsService.getPriceList(seeded.A.priceListId, dsB.manager)).rejects.toThrow();
  });

  it("listItems resolves each Company's own product snapshot through the nested manager-threaded ProductsService call — never falls back to the ambient connection", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);

    const itemsA = await priceListsService.listItems(seeded.A.priceListId, dsA.manager);
    expect(itemsA).toHaveLength(1);
    expect(itemsA[0]).toMatchObject({ sku: 'SKU-PL-A', productName: 'SKU-PL-A Product', price: seeded.A.itemPrice });

    const itemsB = await priceListsService.listItems(seeded.B.priceListId, dsB.manager);
    expect(itemsB).toHaveLength(1);
    expect(itemsB[0]).toMatchObject({ sku: 'SKU-PL-B', productName: 'SKU-PL-B Product', price: seeded.B.itemPrice });
  });

  it("resolvePrice for Company A's product+main-list returns Company A's own override price, never Company B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);

    const resolvedA = await priceListsService.resolvePrice(null, seeded.A.productId, dsA.manager);
    expect(resolvedA).toEqual({ price: seeded.A.itemPrice, priceListId: seeded.A.priceListId });

    const resolvedB = await priceListsService.resolvePrice(null, seeded.B.productId, dsB.manager);
    expect(resolvedB).toEqual({ price: seeded.B.itemPrice, priceListId: seeded.B.priceListId });
  });

  it("Test F — resolving Company A's price lists never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await priceListsService.listPriceLists(dsA.manager);
      await priceListsService.listItems(seeded.A.priceListId, dsA.manager);
      await priceListsService.resolvePrice(null, seeded.A.productId, dsA.manager);
    });
  });
});
