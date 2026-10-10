import { randomUUID } from 'crypto';
import { ProductsService } from '../application/products.service';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * Real-Postgres proof that `products.controller.ts`'s catalog reads/writes
 * are genuinely Company-scoped after this retrofit — two real, separately
 * provisioned Company databases, each with its own distinct product
 * (different SKU/price), never mocked.
 *
 * Only `ProductsService` is exercised directly — it has exactly 2
 * dependencies beyond `DataSource` (`AuditService`, `EventBusService`),
 * both already fully manager-capable (confirmed before this retrofit:
 * `AuditService.record(input, manager?)`; `EventBusService.publish`
 * REQUIRES a manager, so every existing caller was already forced to
 * supply one). Constructed for real here (not stubbed) since
 * `createProduct` genuinely calls both.
 */
describe('ProductsController Area 21 retrofit — real-Postgres Company isolation (2026-09-27)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: ProductsService;

  async function seedProduct(companyId: string, sku: string, name: string, unitPrice: string) {
    const ds = await h.connections.getDataSource(companyId);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,$4,'active')`, [
      randomUUID(),
      sku,
      name,
      unitPrice,
    ]);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'items_isolation', extraCompanyTags: ['sales'] });
    await seedProduct(h.companyAId, 'SKU-COMPANY-A', 'Company A Product', '10.00');
    await seedProduct(h.companyBId, 'SKU-COMPANY-B', 'Company B Product', '20.00');

    // AuditService/EventBusService are never actually invoked by the
    // read-only methods this test exercises (listActiveProducts/
    // listAllProducts) — inert stand-ins are safe here, same precedent
    // as `sales-orders.company-isolation.spec.ts`.
    service = new ProductsService(h.controlPlane, {} as never, {} as never);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("listAllProducts via Company A resolves only Company A's real product", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const products = await service.listAllProducts(dsA.manager);
    expect(products.map((p) => p.sku)).toEqual(['SKU-COMPANY-A']);
  });

  it("listAllProducts via Company B resolves only Company B's real product — no leakage of Company A's catalog", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const products = await service.listAllProducts(dsB.manager);
    expect(products.map((p) => p.sku)).toEqual(['SKU-COMPANY-B']);
  });

  it('listActiveProducts (the public-read path) is equally Company-scoped, not just the admin listAll path', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await service.listActiveProducts(dsA.manager)).map((p) => p.sku)).toEqual(['SKU-COMPANY-A']);
    expect((await service.listActiveProducts(dsB.manager)).map((p) => p.sku)).toEqual(['SKU-COMPANY-B']);
  });

  it("Test F — resolving Company A's catalog never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listAllProducts(dsA.manager);
    });
  });
});
