import { EventBusService } from '../../../foundation/events/event-bus.service';
import { randomUUID } from 'crypto';
import { SalesReturnsService } from '../application/sales-returns.service';
import { OrderLineReturnCapacityService } from '../application/order-line-return-capacity.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { CustomersService } from '../../crm/application/customers.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { SalesReturn } from '../infrastructure/sales-return.entity';
import { ReturnFinancialsService } from '../application/return-financials.service';
import { InventoryValuationService } from '../../inventory-valuation/application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../../inventory-valuation/application/moving-average-cost-engine.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `sales-returns.controller.ts`'s reads/writes are
 * genuinely Company-scoped — two real, separately provisioned Company
 * databases, each with its own customer, warehouse, sold-and-shipped order
 * line, never mocked. `SalesOrdersService`/`CustomersService` are
 * constructed with an *inert* ambient DataSource, so any call that failed
 * to receive the Company manager would crash rather than silently read the
 * wrong database.
 *
 * `createSalesReturn` is the deep-chain proof (eligibility read via the
 * sales-orders contract, row-locked capacity read on `sales_order_lines`/
 * `shipment_lines`/return lines, header + lines + process start in one
 * transaction); `completeSalesReturn` writes the restock ledger movement.
 */
describe('SalesReturnsController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: SalesReturnsService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { customerId: string; orderLineId: string; productId: string; warehouseId: string; returnId: string }> = {
    A: { customerId: '', orderLineId: '', productId: '', warehouseId: '', returnId: '' },
    B: { customerId: '', orderLineId: '', productId: '', warehouseId: '', returnId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', code: string) {
    const ds = await h.connections.getDataSource(companyId);
    const customerId = randomUUID();
    const warehouseId = randomUUID();
    const productId = randomUUID();
    const orderId = randomUUID();
    const orderLineId = randomUUID();
    const shipmentId = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Admin',
      `iso-admin-${companyId}@test.local`,
    ]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actorUserId, role[0].id]);
    await ds.query(`INSERT INTO "customers" ("id","code","name") VALUES ($1,$2,$3)`, [customerId, `CUST-${code}`, `${code} Customer`]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$3,'active')`, [warehouseId, `WH-${code}`, `${code} Warehouse`]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'10.00','active')`, [productId, `SKU-${code}`, `${code} Product`]);
    await ds.query(
      `INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount","warehouseId") VALUES ($1,$2,$3,$4,'100.00',$5)`,
      [orderId, `SO-RET-${code}`, customerId, actorUserId, warehouseId],
    );
    await ds.query(
      `INSERT INTO "sales_order_lines" ("id","salesOrderId","productId","quantity","unitPrice","listPrice","lineTotal") VALUES ($1,$2,$3,10,'10.00','10.00','100.00')`,
      [orderLineId, orderId, productId],
    );
    await ds.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber") VALUES ($1,$2,$3)`, [shipmentId, randomUUID(), `WB-RET-${code}`]);
    await ds.query(
      `INSERT INTO "shipment_lines" ("id","shipmentId","salesOrderLineId","productId","quantity","unitPrice","lineTotal") VALUES ($1,$2,$3,$4,10,'10.00','100.00')`,
      [randomUUID(), shipmentId, orderLineId, productId],
    );

    // D4 — the sale's stock really left at a known cost (dispatch movement + its costed valuation issue row, 10 @ 4.00).
    const dispatchId = randomUUID();
    await ds.query(
      `INSERT INTO "stock_movements" ("id","warehouseId","productId","quantity","movementType","referenceType","referenceId") VALUES ($1,$2,$3,-10,'dispatch','sales_order',$4)`,
      [dispatchId, warehouseId, productId, orderId],
    );
    await ds.query(
      `INSERT INTO "inventory_valuation_movements" ("productId","warehouseId","kind","stockMovementId","quantity","quantityBeforeValueBase","valueDeltaBase","quantityAfterValueBase","averageCostAfterBase","idempotencyKey") VALUES ($1,$2,'issue',$3,-10,'100.0000','-40.0000','60.0000','4.0000',$4)`,
      [productId, warehouseId, dispatchId, `inventory:movement:${dispatchId}:recorded`],
    );
    seeded[key] = { customerId, orderLineId, productId, warehouseId, returnId: '' };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'sr_isolation', extraCompanyTags: ['sales', 'inventory', 'finance', 'logistics'] });
    await seedCompanyData(h.companyAId, 'A', 'A');
    await seedCompanyData(h.companyBId, 'B', 'B');

    const dsA = await h.connections.getDataSource(h.companyAId);
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const processEngine = new ProcessEngineService(h.controlPlane);
    // Fallback-only; every call supplies its own manager, which always wins.
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const salesOrders = new SalesOrdersService(inert, inert, inert, inert, authorization, inert, inert, inert, inert, inert, inert);
    const customers = new CustomersService(inert, inert, inert, inert, inert, inert, inert, inert);

    // D4 — returns now also post financially. This spec proves Company SCOPING; the GL/ledger side is proven in
    // returns-accounting.company-isolation.spec.ts, so the accounting policy is a pass-through stub and the order has no invoice.
    const policyRegistry = new InventoryPostingPolicyRegistry();
    policyRegistry.bind({
      assertManualReceiptReason: async () => ({ glAccountCode: 'stub' }),
      listManualReceiptReasons: () => [],
      assertSaleReturnPostable: async () => undefined,
      assertSupplierInvoicePostable: async () => undefined,
    });
    const valuation = new InventoryValuationService(new MovingAverageCostEngine(h.controlPlane));
    const eventBus = new EventBusService(inert, h.connections);
    const ledgerStub = { postEntry: async () => undefined } as never;
    const invoicesStub = { getReturnBasis: async () => null, recomputeStatus: async () => 'posted' } as never;
    const inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, eventBus, valuation as never, policyRegistry);
    // Installation-wide in-memory config (Gate D note, §45) — a fixed policy value for the test.
    const config = { get: () => 365 } as unknown as ConfigurationEngineService;
    const financials = new ReturnFinancialsService(inventory, salesOrders, ledgerStub, invoicesStub, eventBus, policyRegistry);
    service = new SalesReturnsService(h.controlPlane, processEngine, audit, numbering, config, inventory, salesOrders, customers, new OrderLineReturnCapacityService(), financials, eventBus);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("createSalesReturn for Company A writes the return + lines inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const ret = await service.createSalesReturn(
      seeded.A.customerId,
      null,
      new Date(),
      [{ sourceSalesOrderLineId: seeded.A.orderLineId, returnQuantity: 3, returnPrice: '10.00' }],
      'damaged',
      actorUserId,
      dsA.manager,
    );
    seeded.A.returnId = ret.id;
    expect(ret.totalAmount).toBe('30.00');
    expect(await dsA.getRepository(SalesReturn).findOne({ where: { id: ret.id } })).toBeTruthy();
  });

  it("createSalesReturn for Company B writes independently in Company B's own database", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const ret = await service.createSalesReturn(
      seeded.B.customerId,
      null,
      new Date(),
      [{ sourceSalesOrderLineId: seeded.B.orderLineId, returnQuantity: 5, returnPrice: '10.00' }],
      null,
      actorUserId,
      dsB.manager,
    );
    seeded.B.returnId = ret.id;
    expect(await dsB.getRepository(SalesReturn).findOne({ where: { id: seeded.A.returnId } })).toBeNull();
  });

  it("createSalesReturn with Company A's order line through Company B's manager is rejected (wrong-resource-id DENY)", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(
      service.createSalesReturn(
        seeded.B.customerId,
        null,
        new Date(),
        [{ sourceSalesOrderLineId: seeded.A.orderLineId, returnQuantity: 1, returnPrice: '10.00' }],
        null,
        actorUserId,
        dsB.manager,
      ),
    ).rejects.toThrow(/not found|outside/i);
  });

  it("completeSalesReturn for Company A restocks into Company A's own ledger only", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect(await service.completeSalesReturn(seeded.A.returnId, actorUserId, dsA.manager)).toBe('completed');
    const movementsA: Array<{ quantity: number }> = await dsA.query(`SELECT "quantity" FROM "stock_movements" WHERE "productId" = $1 AND "movementType" = 'return_in'`, [seeded.A.productId]);
    expect(movementsA.map((m) => Number(m.quantity))).toEqual([3]);
    // Company B has only its own seeded dispatch fixture — no return_in, no valuation restore, nothing from A's completion
    const movementsB: Array<{ quantity: number }> = await dsB.query(`SELECT "quantity" FROM "stock_movements" WHERE "movementType" = 'return_in'`);
    expect(movementsB).toHaveLength(0);
  });

  it('listSalesReturns via Company A returns only A\'s return (state completed, A\'s customer); via Company B only B\'s (state requested)', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const a = await service.listSalesReturns(dsA.manager);
    const b = await service.listSalesReturns(dsB.manager);
    expect(a.map((r) => [r.id, r.state, r.customerName])).toEqual([[seeded.A.returnId, 'completed', 'A Customer']]);
    expect(b.map((r) => [r.id, r.state, r.customerName])).toEqual([[seeded.B.returnId, 'requested', 'B Customer']]);
  });

  it("getSalesReturnDetail / completeSalesReturn of Company A's id through Company B's manager is rejected (A→B DENY)", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(service.getSalesReturnDetail(seeded.A.returnId, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(service.completeSalesReturn(seeded.A.returnId, actorUserId, dsB.manager)).rejects.toThrow(/not found/i);
  });

  it("listEligiblePurchaseLines resolves only the owning Company's own purchase history", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await service.listEligiblePurchaseLines(seeded.A.customerId, new Date(), dsA.manager)).map((l) => l.salesOrderLineId)).toEqual([seeded.A.orderLineId]);
    expect(await service.listEligiblePurchaseLines(seeded.A.customerId, new Date(), dsB.manager)).toHaveLength(0);
  });

  it("Test F — resolving Company A's sales returns never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listSalesReturns(dsA.manager);
      await service.getSalesReturnDetail(seeded.A.returnId, dsA.manager);
    });
  });
});
