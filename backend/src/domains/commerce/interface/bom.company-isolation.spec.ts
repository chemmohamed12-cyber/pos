import { randomUUID } from 'crypto';
import { BomService } from '../application/bom.service';
import { ProductsService } from '../application/products.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `bom.controller.ts`'s reads/writes are
 * genuinely Company-scoped after this retrofit — two real, separately
 * provisioned Company databases, each with its own distinct finished
 * product, component product, and Bill of Materials, never mocked.
 *
 * `ProductsService` is constructed for real (only `AuditService`/
 * `EventBusService` dependencies, same precedent as
 * `products.company-isolation.spec.ts`) since `defineBom`/`getBom`/
 * `listBoms` all genuinely call `products.getProductSnapshot`.
 */
describe('BomController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: BomService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { finishedProductId: string; componentProductId: string }> = {
    A: { finishedProductId: '', componentProductId: '' },
    B: { finishedProductId: '', componentProductId: '' },
  };

  async function seedProducts(companyId: string, key: 'A' | 'B', prefix: string) {
    const ds = await h.connections.getDataSource(companyId);
    const finishedProductId = randomUUID();
    const componentProductId = randomUUID();
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'50.00','active')`, [
      finishedProductId,
      `${prefix}-FIN`,
      `${prefix} Finished Product`,
    ]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'5.00','active')`, [
      componentProductId,
      `${prefix}-COMP`,
      `${prefix} Component Product`,
    ]);
    seeded[key] = { finishedProductId, componentProductId };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'bom_isolation', extraCompanyTags: ['sales'] });
    await seedProducts(h.companyAId, 'A', 'BOM-A');
    await seedProducts(h.companyBId, 'B', 'BOM-B');

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const products = new ProductsService(h.controlPlane, audit, inert);
    service = new BomService(h.controlPlane, audit, products);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("defineBom for Company A creates its own BOM inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const bom = await service.defineBom(
      seeded.A.finishedProductId,
      [{ componentProductId: seeded.A.componentProductId, quantityPerUnit: 3 }],
      actorUserId,
      dsA.manager,
    );
    expect(bom.finishedProductId).toBe(seeded.A.finishedProductId);
  });

  it("defineBom for Company B creates independently in Company B's own database — no leakage of Company A's BOM", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const bom = await service.defineBom(
      seeded.B.finishedProductId,
      [{ componentProductId: seeded.B.componentProductId, quantityPerUnit: 7 }],
      actorUserId,
      dsB.manager,
    );
    expect(bom.finishedProductId).toBe(seeded.B.finishedProductId);
  });

  it("getBom for Company A resolves only Company A's own recipe (its own component SKU/quantity), never Company B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const bom = await service.getBom(seeded.A.finishedProductId, dsA.manager);
    expect(bom).toBeTruthy();
    expect(bom!.finishedProductSku).toBe('BOM-A-FIN');
    expect(bom!.components).toEqual([{ componentProductId: seeded.A.componentProductId, quantityPerUnit: 3, sku: 'BOM-A-COMP', productName: 'BOM-A Component Product', unit: null }]);
  });

  it("listBoms via Company A resolves only Company A's own BOM — never Company B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const boms = await service.listBoms(dsA.manager);
    expect(boms.map((b) => b.finishedProductId)).toEqual([seeded.A.finishedProductId]);
  });

  it("listBoms via Company B resolves only Company B's own BOM — no leakage of Company A's data", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const boms = await service.listBoms(dsB.manager);
    expect(boms.map((b) => b.finishedProductId)).toEqual([seeded.B.finishedProductId]);
  });

  it("deleteBom for Company A removes only Company A's own BOM — Company B's stays untouched", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await service.deleteBom(seeded.A.finishedProductId, actorUserId, dsA.manager);
    const remaining = await service.listBoms(dsA.manager);
    expect(remaining).toHaveLength(0);

    const dsB = await h.connections.getDataSource(h.companyBId);
    const bStillThere = await service.listBoms(dsB.manager);
    expect(bStillThere).toHaveLength(1);
  });

  it("Test F — resolving Company B's BOM never even requests Company A's DataSource", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyAId, async () => {
      await service.listBoms(dsB.manager);
      await service.getBom(seeded.B.finishedProductId, dsB.manager);
    });
  });
});
