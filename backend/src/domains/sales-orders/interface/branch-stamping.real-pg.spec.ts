import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { FulfillmentService } from '../../fulfillment/application/fulfillment.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { InvoiceService } from '../../customer-finance/application/invoices.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { CustomersService } from '../../crm/application/customers.service';
import { TaxEngineService } from '../../accounting/application/tax-engine.service';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { SalesOrdersReadContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Org engine Stage 5 (real PostgreSQL) — the branch reference is STAMPED BY THE SERVER, from business relationships, and inherited down the chain:
 *   warehouse (owning branch) -> sales order -> fulfillment order / invoice / shipment.
 * A document created without any branch information stays NULL (no default branch is ever invented), a custody sub-location resolves to its parent warehouse's
 * branch, and an already-stamped document is never rewritten by a later change of the warehouse's branch (history is not rewritten).
 */
describe('Branch stamping down the sales chain (real Postgres)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let inventory: InventoryService;
  let fulfillment: FulfillmentService;
  let invoices: InvoiceService;
  let shipments: ShipmentService;
  let m: EntityManager;
  const actor = randomUUID();
  const ids = { x: randomUUID(), y: randomUUID(), whX: randomUUID(), whCustody: randomUUID(), whLegacy: randomUUID(), customer: randomUUID(), product: randomUUID() };

  const order = async (warehouseId: string | null, branch: string | null, n: string) => {
    const id = randomUUID();
    await m.query(
      `INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount","repSequenceNumber","createdByUserId","warehouseId","branchOrgUnitId") VALUES ($1,$2,$3,$4,'200.00',1,$4,$5,$6)`,
      [id, `SO-BR-${n}`, ids.customer, actor, warehouseId, branch],
    );
    await m.query(`INSERT INTO "sales_order_lines" ("id","salesOrderId","productId","quantity","unitPrice","listPrice","discountAmount","lineTotal") VALUES ($1,$2,$3,2,'100.00','100.00','0.00','200.00')`, [randomUUID(), id, ids.product]);
    return id;
  };
  const reserve = (orderId: string, warehouseId: string) =>
    m.query(`INSERT INTO "stock_reservations" ("id","warehouseId","productId","quantity","salesOrderId","status") VALUES ($1,$2,$3,2,$4,'active')`, [randomUUID(), warehouseId, ids.product, orderId]);

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'branch_stamp', extraCompanyTags: ['sales', 'inventory', 'finance', 'accounting', 'logistics'] });
    m = (await h.connections.getDataSource(h.companyAId)).manager;
    await m.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Stamp Admin','stamp-admin@test.local')`, [actor]);
    await m.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await m.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await m.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3)`, [randomUUID(), actor, role[0].id]);
    await m.query(`INSERT INTO org_units (id,type,name) VALUES ($1,'branch','X'),($2,'branch','Y')`, [ids.x, ids.y]);
    await m.query(`INSERT INTO "warehouses" ("id","code","name","status","kind","orgUnitId") VALUES ($1,'WH-X','X wh','active','main',$2)`, [ids.whX, ids.x]);
    await m.query(`INSERT INTO "warehouses" ("id","code","name","status","kind","parentWarehouseId") VALUES ($1,'WH-X-VEH','X custody','active','operational',$2)`, [ids.whCustody, ids.whX]);
    await m.query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,'WH-OLD','Legacy wh','active','main')`, [ids.whLegacy]);
    await m.query(`INSERT INTO "customers" ("id","code","name","creditLimit","paymentTermsDays") VALUES ($1,'CUST-BR','Branch Customer','100000.00',30)`, [ids.customer]);
    await m.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-BR','P','100.00','active')`, [ids.product]);

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert, h.connections);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const authorization = new AuthorizationService(m.getRepository(Role), m.getRepository(UserRole));
    inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, inert, undefined);
    fulfillment = new FulfillmentService(h.controlPlane, processEngine, inert, audit, events, inventory, numbering);

    // order-read contract: a thin accessor over the Company's own tables (the order domain's createOrder is exercised on the real app in the browser acceptance)
    const salesOrders = {
      async getOrder(orderId: string, _u: string, manager?: EntityManager) {
        const [row] = await manager!.query(`SELECT "customerId","warehouseId","branchOrgUnitId" FROM sales_orders WHERE id = $1`, [orderId]);
        return row;
      },
      async getOrderLines(orderId: string, manager?: EntityManager) {
        return manager!.query(`SELECT id,"productId",quantity,"unitPrice"::text AS "unitPrice","discountAmount"::text AS "discountAmount","lineTotal"::text AS "lineTotal" FROM sales_order_lines WHERE "salesOrderId" = $1`, [orderId]);
      },
      async getOrderSnapshot(orderId: string, manager?: EntityManager) {
        const [row] = await manager!.query(`SELECT id,"orderNumber","customerId","salesRepUserId","totalAmount","branchOrgUnitId" FROM sales_orders WHERE id = $1`, [orderId]);
        return row ?? null;
      },
    } as unknown as SalesOrdersReadContract;
    const customers = new CustomersService(h.controlPlane, inert, inert, inert, inert, authorization, inert, inert);
    invoices = new InvoiceService(
      h.controlPlane, numbering, processEngine, audit, salesOrders, customers, new CustomerLedgerService(h.controlPlane, numbering, audit, customers), events, new TaxEngineService(h.controlPlane, { get: () => null } as never),
    );
    const treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, inert);
    shipments = new ShipmentService(h.controlPlane, numbering, processEngine, authorization, audit, { publish: async () => undefined } as never, inventory, fulfillment, treasury, salesOrders, inert, inert);
  });
  afterAll(async () => h.teardown());

  it('the warehouse resolves its owning branch: own link, else its parent’s (custody sub-location), else null (legacy)', async () => {
    expect(await inventory.getWarehouseBranchId(ids.whX, m)).toBe(ids.x);
    expect(await inventory.getWarehouseBranchId(ids.whCustody, m)).toBe(ids.x);
    expect(await inventory.getWarehouseBranchId(ids.whLegacy, m)).toBeNull();
    expect(await inventory.getWarehouseBranchId(randomUUID(), m)).toBeNull();
  });

  it('fulfillment order takes the branch of its warehouse; a legacy warehouse leaves it NULL (no default branch is invented)', async () => {
    const o1 = await order(ids.whX, ids.x, '1');
    await reserve(o1, ids.whX);
    const { fulfillmentOrder } = await fulfillment.createFulfillmentOrder(o1, actor, m);
    expect(fulfillmentOrder.branchOrgUnitId).toBe(ids.x);
    const o2 = await order(ids.whLegacy, null, '2');
    await reserve(o2, ids.whLegacy);
    expect((await fulfillment.createFulfillmentOrder(o2, actor, m)).fulfillmentOrder.branchOrgUnitId).toBeNull();
  });

  it('invoice inherits the order’s branch, and a later change of the warehouse’s branch does not rewrite the already-stamped documents', async () => {
    const o = await order(ids.whX, ids.x, '3');
    const inv = await invoices.createDraftInvoice(o, actor, null, m);
    expect(inv.branchOrgUnitId).toBe(ids.x);
    await m.query(`UPDATE warehouses SET "orgUnitId" = $1 WHERE id = $2`, [ids.y, ids.whX]); // the warehouse moves to branch Y
    expect((await m.query(`SELECT "branchOrgUnitId" FROM sales_orders WHERE id = $1`, [o]))[0].branchOrgUnitId).toBe(ids.x); // history keeps X
    expect((await m.query(`SELECT "branchOrgUnitId" FROM sales_invoices WHERE id = $1`, [inv.id]))[0].branchOrgUnitId).toBe(ids.x);
    expect(await inventory.getWarehouseBranchId(ids.whX, m)).toBe(ids.y); // only NEW documents follow
    await m.query(`UPDATE warehouses SET "orgUnitId" = $1 WHERE id = $2`, [ids.x, ids.whX]);
  });

  it('shipment inherits the order’s branch through the fulfillment order; an unassigned order gives an unassigned shipment', async () => {
    const o = await order(ids.whX, ids.x, '4');
    await reserve(o, ids.whX);
    const fo = (await fulfillment.createFulfillmentOrder(o, actor, m)).fulfillmentOrder;
    const s = await shipments.createShipment(fo.id, actor, null, null, null, m);
    expect(s.branchOrgUnitId).toBe(ids.x);
    const legacy = await order(ids.whLegacy, null, '5');
    await reserve(legacy, ids.whLegacy);
    const fo2 = (await fulfillment.createFulfillmentOrder(legacy, actor, m)).fulfillmentOrder;
    expect((await shipments.createShipment(fo2.id, actor, null, null, null, m)).branchOrgUnitId).toBeNull();
  });

  it('financial values are untouched by stamping: invoice totals equal the order lines', async () => {
    const [row] = await m.query(`SELECT "totalAmount","subtotal" FROM sales_invoices ORDER BY "createdAt" LIMIT 1`);
    expect(row.totalAmount).toBe('200.00');
  });
});
