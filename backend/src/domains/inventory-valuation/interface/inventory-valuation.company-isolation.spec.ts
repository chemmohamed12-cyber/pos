import { randomUUID } from 'crypto';
import { InventoryValuationService } from '../application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../application/moving-average-cost-engine.service';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * Real-Postgres proof that `inventory-valuation.controller.ts`'s one route
 * is genuinely Company-scoped after this retrofit — two real, separately
 * provisioned Company databases, each with its own distinct
 * `inventory_valuation_state` row (a different average cost), never
 * mocked. `InventoryValuationService.getUnitCost`/`MovingAverageCostEngine.
 * resolveIssueCost` were both already fully `manager?`-capable BEFORE
 * this pass (confirmed while retrofitting `inventory.controller.ts`'s
 * `assembleProduct`) — this test proves that pre-existing capability
 * actually resolves per-Company data, which no prior test exercised
 * directly through this controller's own service.
 */
describe('InventoryValuationController Area 21 retrofit — real-Postgres Company isolation (2026-09-27)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: InventoryValuationService;

  const seeded: Record<'A' | 'B', { productId: string; warehouseId: string; cost: string }> = {
    A: { productId: '', warehouseId: '', cost: '12.5000' },
    B: { productId: '', warehouseId: '', cost: '99.0000' },
  };

  async function seedCompanyState(companyId: string, key: 'A' | 'B') {
    const ds = await h.connections.getDataSource(companyId);
    const productId = randomUUID();
    const warehouseId = randomUUID();
    await ds.query(
      `INSERT INTO "inventory_valuation_state" ("id","productId","warehouseId","onHandQuantity","totalValueBase","averageCostBase","currencyCode")
       VALUES ($1,$2,$3,10,$4,$5,'EGP')`,
      [randomUUID(), productId, warehouseId, (Number(seeded[key].cost) * 10).toFixed(4), seeded[key].cost],
    );
    seeded[key].productId = productId;
    seeded[key].warehouseId = warehouseId;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'inv_valuation_isolation', extraCompanyTags: ['sales', 'inventory'] });
    await seedCompanyState(h.companyAId, 'A');
    await seedCompanyState(h.companyBId, 'B');

    const engine = new MovingAverageCostEngine(h.controlPlane);
    service = new InventoryValuationService(engine);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("getUnitCost for Company A's own product/warehouse resolves Company A's own average cost", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const result = await service.getUnitCost(seeded.A.productId, seeded.A.warehouseId, undefined, dsA.manager);
    expect(result).toEqual({ unitCostBase: seeded.A.cost });
  });

  it("getUnitCost for Company B's own product/warehouse resolves Company B's own average cost — never Company A's", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const result = await service.getUnitCost(seeded.B.productId, seeded.B.warehouseId, undefined, dsB.manager);
    expect(result).toEqual({ unitCostBase: seeded.B.cost });
  });

  it("getUnitCost for Company A's product/warehouse via Company B's manager resolves null — the row genuinely does not exist in Company B's own database", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const result = await service.getUnitCost(seeded.A.productId, seeded.A.warehouseId, undefined, dsB.manager);
    expect(result).toBeNull();
  });

  it("Test F — resolving Company A's valuation state never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.getUnitCost(seeded.A.productId, seeded.A.warehouseId, undefined, dsA.manager);
    });
  });
});
