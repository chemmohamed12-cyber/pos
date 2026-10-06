import { randomUUID } from 'crypto';
import { WarehouseTransactionsService } from '../application/warehouse-transactions.service';
import { InventoryService } from '../application/inventory.service';
import { ProductsService } from '../../commerce/application/products.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { WarehouseTransaction } from '../infrastructure/warehouse-transaction.entity';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `warehouse-transactions.controller.ts`'s
 * reads/writes are genuinely Company-scoped — two real, separately
 * provisioned Company databases, each with its own warehouse, product and
 * transaction documents, never mocked.
 *
 * The receipt `submit` → auto-`post` path is the deep-chain proof: it
 * exercises the document-locked `postTransaction` transaction, the real
 * `InventoryService.recordMovement` ledger write, and the Process Engine
 * transition, all against each Company's own database.
 */
describe('WarehouseTransactionsController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: WarehouseTransactionsService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { warehouseId: string; productId: string; receiptId: string }> = {
    A: { warehouseId: '', productId: '', receiptId: '' },
    B: { warehouseId: '', productId: '', receiptId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', code: string) {
    const ds = await h.connections.getDataSource(companyId);
    const warehouseId = randomUUID();
    const productId = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Admin',
      `iso-admin-${companyId}@test.local`,
    ]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      randomUUID(),
      actorUserId,
      role[0].id,
    ]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,$2,$3,'active','main')`, [
      warehouseId,
      `WH-${code}`,
      `${code} Warehouse`,
    ]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'10.00','active')`, [
      productId,
      `SKU-${code}`,
      `${code} Product`,
    ]);
    seeded[key] = { warehouseId, productId, receiptId: '' };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'wh_txn_isolation', extraCompanyTags: ['sales', 'inventory'] });
    await seedCompanyData(h.companyAId, 'A', 'A');
    await seedCompanyData(h.companyBId, 'B', 'B');

    const dsA = await h.connections.getDataSource(h.companyAId);
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const processEngine = new ProcessEngineService(h.controlPlane);
    // Fallback-only construction (every call supplies its own manager, which always wins).
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const products = new ProductsService(h.controlPlane, audit, inert);
    // D3-B — a receipt needs an explicit cost + a controlled reason validated by the accounting-bound policy. This spec proves
    // DOCUMENT scoping (the GL side of the policy is proven in manual-receipt.company-isolation.spec.ts), so the policy is a
    // pass-through stub and the event bus accepts the manual-receipt publish.
    const policyRegistry = new InventoryPostingPolicyRegistry();
    policyRegistry.bind({
      assertManualReceiptReason: async () => ({ glAccountCode: 'stub' }),
      listManualReceiptReasons: () => ['FOUND_STOCK'],
      assertSaleReturnPostable: async () => undefined,
      assertSupplierInvoicePostable: async () => undefined,
    });
    const eventsStub = { publish: async () => undefined } as never;
    const inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, eventsStub, undefined, policyRegistry);
    service = new WarehouseTransactionsService(h.controlPlane, numbering, processEngine, authorization, audit, products, inventory, policyRegistry);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("createTransaction (receipt) for Company A writes its document + lines inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const txn = await service.createTransaction(
      'receipt',
      seeded.A.warehouseId,
      null,
      [{ productId: seeded.A.productId, quantity: 7, unitCostBase: '2.00' }],
      null,
      null,
      null,
      actorUserId,
      undefined,
      dsA.manager,
      'FOUND_STOCK',
    );
    seeded.A.receiptId = txn.id;
    expect(await dsA.getRepository(WarehouseTransaction).findOne({ where: { id: txn.id } })).toBeTruthy();
  });

  it("createTransaction (receipt) for Company B writes independently in Company B's own database", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const txn = await service.createTransaction(
      'receipt',
      seeded.B.warehouseId,
      null,
      [{ productId: seeded.B.productId, quantity: 3, unitCostBase: '2.00' }],
      null,
      null,
      null,
      actorUserId,
      undefined,
      dsB.manager,
      'FOUND_STOCK',
    );
    seeded.B.receiptId = txn.id;
    expect(await dsB.getRepository(WarehouseTransaction).findOne({ where: { id: seeded.A.receiptId } })).toBeNull();
  });

  it("transition('submit') for Company A auto-posts the receipt and writes the stock movement only into Company A's ledger", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const state = await service.transition(seeded.A.receiptId, 'submit', actorUserId, dsA.manager);
    expect(state).toBe('posted');

    const movementsA: Array<{ quantity: number }> = await dsA.query(`SELECT "quantity" FROM "stock_movements" WHERE "productId" = $1`, [seeded.A.productId]);
    expect(movementsA.map((m) => Number(m.quantity))).toEqual([7]);

    const dsB = await h.connections.getDataSource(h.companyBId);
    const movementsB: Array<{ quantity: number }> = await dsB.query(`SELECT "quantity" FROM "stock_movements"`);
    expect(movementsB).toHaveLength(0);
  });

  it('listTransactions via Company A resolves only Company A\'s own document, and via Company B only Company B\'s', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const a = await service.listTransactions({}, dsA.manager);
    const b = await service.listTransactions({}, dsB.manager);
    expect(a.map((t) => t.id)).toEqual([seeded.A.receiptId]);
    expect(b.map((t) => t.id)).toEqual([seeded.B.receiptId]);
    expect(a[0].state).toBe('posted');
    expect(b[0].state).toBe('draft');
  });

  it('startCount for Company B creates the count document only in Company B, capturing its own on-hand', async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const count = await service.startCount(seeded.B.warehouseId, [seeded.B.productId], actorUserId, dsB.manager);
    expect(count.type).toBe('count');
    const lines = await service.getLines(count.id, dsB.manager);
    expect(lines).toHaveLength(1);
    expect(lines[0].systemQuantity).toBe(0);

    const dsA = await h.connections.getDataSource(h.companyAId);
    expect(await dsA.getRepository(WarehouseTransaction).findOne({ where: { id: count.id } })).toBeNull();
  });

  it("getOverview via Company A reports Company A's own figures (1 warehouse, 7 units on hand at 10.00)", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const overview = await service.getOverview(dsA.manager);
    expect(overview.totalWarehouses).toBe(1);
    expect(overview.totalInventoryValueAtSellingPrice).toBe('70.00');
  });

  it("Test F — resolving Company A's warehouse transactions never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listTransactions({}, dsA.manager);
      await service.getTransaction(seeded.A.receiptId, dsA.manager);
      await service.getOverview(dsA.manager);
    });
  });
});
