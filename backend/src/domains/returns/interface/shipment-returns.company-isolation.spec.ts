import { EventBusService } from '../../../foundation/events/event-bus.service';
import { randomUUID } from 'crypto';
import { ShipmentReturnsService } from '../application/shipment-returns.service';
import { OrderLineReturnCapacityService } from '../application/order-line-return-capacity.service';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { CustomersService } from '../../crm/application/customers.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { ShipmentReturn } from '../infrastructure/shipment-return.entity';
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
 * Real-Postgres proof that `shipment-returns.controller.ts`'s reads/writes
 * are genuinely Company-scoped — two real, separately provisioned Company
 * databases, each with its own customer, warehouse, order and *shipped*
 * order line. `ShipmentService`, `SalesOrdersService` and
 * `CustomersService` are built with an **inert ambient DataSource**, so a
 * call that missed the Company manager would crash instead of silently
 * reading the wrong database. `createShipmentReturn` is the deep-chain
 * proof (shipment-lines snapshot — the closed-§29 gap this retrofit fixed —
 * order snapshot, numbering, row-locked capacity, per-line cap, header +
 * lines + process start in one transaction).
 */
describe('ShipmentReturnsController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: ShipmentReturnsService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { shipmentId: string; shipmentLineId: string; productId: string; returnId: string }> = {
    A: { shipmentId: '', shipmentLineId: '', productId: '', returnId: '' },
    B: { shipmentId: '', shipmentLineId: '', productId: '', returnId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', code: string) {
    const ds = await h.connections.getDataSource(companyId);
    const customerId = randomUUID();
    const warehouseId = randomUUID();
    const productId = randomUUID();
    const orderId = randomUUID();
    const orderLineId = randomUUID();
    const shipmentId = randomUUID();
    const shipmentLineId = randomUUID();
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
      [orderId, `SO-SHR-${code}`, customerId, actorUserId, warehouseId],
    );
    await ds.query(
      `INSERT INTO "sales_order_lines" ("id","salesOrderId","productId","quantity","unitPrice","listPrice","lineTotal") VALUES ($1,$2,$3,10,'10.00','10.00','100.00')`,
      [orderLineId, orderId, productId],
    );
    await ds.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","salesOrderId") VALUES ($1,$2,$3,$4)`, [
      shipmentId,
      randomUUID(),
      `WB-SHR-${code}`,
      orderId,
    ]);
    await ds.query(
      `INSERT INTO "shipment_lines" ("id","shipmentId","salesOrderLineId","productId","quantity","unitPrice","lineTotal") VALUES ($1,$2,$3,$4,10,'10.00','100.00')`,
      [shipmentLineId, shipmentId, orderLineId, productId],
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
    seeded[key] = { shipmentId, shipmentLineId, productId, returnId: '' };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'shr_isolation', extraCompanyTags: ['sales', 'inventory', 'finance', 'logistics'] });
    await seedCompanyData(h.companyAId, 'A', 'A');
    await seedCompanyData(h.companyBId, 'B', 'B');

    const dsA = await h.connections.getDataSource(h.companyAId);
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const processEngine = new ProcessEngineService(h.controlPlane);
    // Fallback-only; every call supplies its own manager, which always wins.
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const shipments = new ShipmentService(inert, inert, inert, inert, inert, inert, inert, inert, inert, inert, inert, inert);
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
    const financials = new ReturnFinancialsService(inventory, salesOrders, ledgerStub, invoicesStub, eventBus, policyRegistry);
    service = new ShipmentReturnsService(h.controlPlane, processEngine, audit, numbering, inventory, salesOrders, customers, shipments, new OrderLineReturnCapacityService(), financials, eventBus);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("createShipmentReturn for Company A writes the return + lines inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const ret = await service.createShipmentReturn(
      seeded.A.shipmentId,
      'partial',
      [{ shipmentLineId: seeded.A.shipmentLineId, returnQuantity: 3, returnPrice: '10.00' }],
      'damaged',
      actorUserId,
      dsA.manager,
    );
    seeded.A.returnId = ret.id;
    expect(await dsA.getRepository(ShipmentReturn).findOne({ where: { id: ret.id } })).toBeTruthy();
  });

  it("createShipmentReturn for Company B writes independently in Company B's own database", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const ret = await service.createShipmentReturn(
      seeded.B.shipmentId,
      'partial',
      [{ shipmentLineId: seeded.B.shipmentLineId, returnQuantity: 5, returnPrice: '10.00' }],
      null,
      actorUserId,
      dsB.manager,
    );
    seeded.B.returnId = ret.id;
    expect(await dsB.getRepository(ShipmentReturn).findOne({ where: { id: seeded.A.returnId } })).toBeNull();
  });

  it("createShipmentReturn against Company A's shipment through Company B's manager is rejected (wrong-resource-id DENY)", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(
      service.createShipmentReturn(
        seeded.A.shipmentId,
        'partial',
        [{ shipmentLineId: seeded.A.shipmentLineId, returnQuantity: 1, returnPrice: '10.00' }],
        null,
        actorUserId,
        dsB.manager,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("getReturnableLines reflects only the owning Company's own prior returns (A: 3 returned, B: 5 returned)", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const a = await service.getReturnableLines(seeded.A.shipmentId, dsA.manager);
    const b = await service.getReturnableLines(seeded.B.shipmentId, dsB.manager);
    expect(a.map((l) => [l.previouslyReturned, l.remaining])).toEqual([[3, 7]]);
    expect(b.map((l) => [l.previouslyReturned, l.remaining])).toEqual([[5, 5]]);
    await expect(service.getReturnableLines(seeded.A.shipmentId, dsB.manager)).rejects.toThrow(/not found/i);
  });

  it("completeShipmentReturn for Company A restocks into Company A's own ledger only", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect(await service.completeShipmentReturn(seeded.A.returnId, actorUserId, dsA.manager)).toBe('completed');
    const movementsA: Array<{ quantity: number }> = await dsA.query(`SELECT "quantity" FROM "stock_movements" WHERE "productId" = $1 AND "movementType" = 'return_in'`, [seeded.A.productId]);
    expect(movementsA.map((m) => Number(m.quantity))).toEqual([3]);
    expect(await dsB.query(`SELECT "quantity" FROM "stock_movements" WHERE "movementType" = 'return_in'`)).toHaveLength(0);
  });

  it('listShipmentReturns via Company A returns only A\'s (completed, 30.00, A\'s customer); via Company B only B\'s (requested, 50.00)', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const a = await service.listShipmentReturns(dsA.manager);
    const b = await service.listShipmentReturns(dsB.manager);
    expect(a.map((r) => [r.id, r.state, r.totalAmount, r.customerName])).toEqual([[seeded.A.returnId, 'completed', '30.00', 'A Customer']]);
    expect(b.map((r) => [r.id, r.state, r.totalAmount, r.customerName])).toEqual([[seeded.B.returnId, 'requested', '50.00', 'B Customer']]);
  });

  it("getShipmentReturnDetail / completeShipmentReturn of Company A's id through Company B's manager is rejected (A→B DENY)", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(service.getShipmentReturnDetail(seeded.A.returnId, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(service.completeShipmentReturn(seeded.A.returnId, actorUserId, dsB.manager)).rejects.toThrow(/not found/i);
  });

  it("Test F — resolving Company A's shipment returns never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listShipmentReturns(dsA.manager);
      await service.getShipmentReturnDetail(seeded.A.returnId, dsA.manager);
      await service.getReturnableLines(seeded.A.shipmentId, dsA.manager);
    });
  });
});
