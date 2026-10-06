import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { ReturnsService } from '../application/returns.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { CustomersService } from '../../crm/application/customers.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { InventoryValuationService } from '../../inventory-valuation/application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../../inventory-valuation/application/moving-average-cost-engine.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { InvoiceService } from '../../customer-finance/application/invoices.service';
import { InventoryPostingPolicyService } from '../../accounting/application/inventory-posting-policy.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 (2026-10-05, CTO-authorized) — real-Postgres Company isolation for `returns.controller.ts` (Matrix §23: its blockers —
 * Shipment/Delivery/Invoice/contract manager gaps — are all closed). Two real Company databases; the real Returns, Inventory,
 * Sales-Orders, Customer Ledger and Invoice services. A return request, its stock movements, disposition, the customer credit
 * and the credit applied to an invoice live only in their own Company.
 */
describe('ReturnsController Area 21 retrofit — real-Postgres Company isolation', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let returns: ReturnsService;
  let ledger: CustomerLedgerService;
  const actor = randomUUID();
  const config: Record<string, unknown> = {};
  type Key = 'A' | 'B';
  const seeded: Record<Key, { customerId: string; warehouseId: string; productId: string; orderId: string; lineId: string; invoiceId: string }> = {
    A: { customerId: randomUUID(), warehouseId: randomUUID(), productId: randomUUID(), orderId: randomUUID(), lineId: randomUUID(), invoiceId: randomUUID() },
    B: { customerId: randomUUID(), warehouseId: randomUUID(), productId: randomUUID(), orderId: randomUUID(), lineId: randomUUID(), invoiceId: randomUUID() },
  };
  const mgr = async (k: Key) => (await h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId)).manager;

  async function seed(k: Key) {
    const ds = await h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);
    const s = seeded[k];
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Returns Isolation Admin',$2) ON CONFLICT DO NOTHING`, [actor, `ret-${k}@test.local`]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actor, role[0].id]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$3,'active')`, [s.warehouseId, `WH-RET-${k}`, `${k} Main`]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'100.00','active')`, [s.productId, `SKU-RET-${k}`, `${k} Product`]);
    await ds.query(`INSERT INTO "customers" ("id","code","name","creditLimit") VALUES ($1,$2,$3,'100000.00')`, [s.customerId, `CUST-RET-${k}`, `${k} Customer`]);
    await ds.query(`INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount","repSequenceNumber","warehouseId") VALUES ($1,$2,$3,$4,'500.00',1,$5)`, [s.orderId, `SO-RET-${k}`, s.customerId, actor, s.warehouseId]);
    await ds.query(`INSERT INTO "sales_order_lines" ("id","salesOrderId","productId","quantity","unitPrice","listPrice","lineTotal") VALUES ($1,$2,$3,5,'100.00','100.00','500.00')`, [s.lineId, s.orderId, s.productId]);
    // a posted invoice for the order, to receive the credit later
    await ds.query(
      `INSERT INTO "sales_invoices" ("id","invoiceNumber","customerId","salesOrderId","subtotal","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,'500.00','500.00',$5)`,
      [s.invoiceId, `INV-RET-${k}`, s.customerId, s.orderId, actor],
    );
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'sales_invoice_lifecycle','sales_invoice',$2,'posted')`, [randomUUID(), s.invoiceId]);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'returns_isolation', extraCompanyTags: ['sales', 'inventory', 'finance', 'logistics'] });
    await seed('A');
    await seed('B');
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert, h.connections);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const cfg = { get: (key: string) => config[key] } as unknown as ConfigurationEngineService;
    const valuation = new InventoryValuationService(new MovingAverageCostEngine(h.controlPlane));
    const policyRegistry = new InventoryPostingPolicyRegistry();
    new InventoryPostingPolicyService(cfg, policyRegistry).onModuleInit();
    const dsA = await h.connections.getDataSource(h.companyAId);
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const salesOrders = new SalesOrdersService(inert, inert, inert, inert, authorization, inert, inert, inert, inert, inert, inert);
    const customers = new CustomersService(inert, inert, inert, inert, inert, authorization, inert, inert);
    const inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, events, valuation as never, policyRegistry);
    ledger = new CustomerLedgerService(h.controlPlane, numbering, audit, customers);
    const invoices = new InvoiceService(h.controlPlane, numbering, processEngine, audit, salesOrders, customers, ledger, events, inert);
    returns = new ReturnsService(h.controlPlane, processEngine, authorization, audit, events, inventory, numbering, salesOrders, inert, inert, ledger, invoices, customers);
  });

  afterAll(async () => {
    await h.teardown();
  });

  let requestA = '';

  it('a return request is created in its own Company; a foreign order line is not a valid reference', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    await expect(returns.createReturnRequest(seeded.A.lineId, 2, 'value_credit', 'damaged', actor, mB)).rejects.toBeInstanceOf(NotFoundException);
    const req = await returns.createReturnRequest(seeded.A.lineId, 2, 'value_credit', 'damaged in transit', actor, mA);
    requestA = req.id;
    expect(req.returnNumber).toMatch(/^RET/);
    await returns.createReturnRequest(seeded.B.lineId, 1, 'exchange', 'wrong size', actor, mB);
    expect((await returns.listReturns(mA)).map((r) => r.id)).toEqual([requestA]);
    expect((await returns.listReturns(mB)).length).toBe(1);
    expect((await returns.getReturnRequest(requestA, mA)).state).toBe('requested');
    await expect(returns.getReturnRequest(requestA, mB)).rejects.toThrow();
  });

  it('authorize → receive → inspect moves stock only inside the Company (its own return sub-location is provisioned there)', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    await expect(returns.authorize(requestA, actor, mB)).rejects.toThrow(); // unknown to B
    expect(await returns.authorize(requestA, actor, mA)).toBe('authorized');
    expect(await returns.receiveAtWarehouse(requestA, actor, mA)).toBe('received');
    expect(await returns.inspect(requestA, actor, mA)).toBe('inspected');
    const sub = await mA.query(`SELECT id, code FROM warehouses WHERE code LIKE 'RETINS-%'`);
    expect(sub.length).toBe(1);
    expect((await mA.query(`SELECT coalesce(sum(quantity),0)::int q FROM stock_movements WHERE "warehouseId" = $1 AND "movementType" = 'return_in'`, [sub[0].id]))[0].q).toBe(2);
    expect((await mB.query(`SELECT count(*)::int n FROM warehouses WHERE code LIKE 'RETINS-%'`))[0].n).toBe(0);
    expect((await mB.query(`SELECT count(*)::int n FROM stock_movements WHERE "movementType" = 'return_in'`))[0].n).toBe(0);
  });

  it('disposition creates the customer credit in the same Company; credits and invoice application stay Company-local', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    const rec = await returns.recordDisposition(requestA, 'restock', null, actor, mA);
    expect(rec.disposition).toBe('restock');
    expect(await returns.getStatus(requestA, mA)).toBe('dispositioned');
    const credit = await returns.getCreditForReturnRequest(requestA, mA);
    expect(credit?.remainingAmount).toBe('200.00'); // 2 x 100.00 — the order line's own historical price
    expect(await returns.getCreditForReturnRequest(requestA, mB)).toBeNull();
    expect((await returns.listAvailableCredits(seeded.A.customerId, mA)).map((c) => c.id)).toEqual([credit!.id]);
    expect(await returns.listAvailableCredits(seeded.A.customerId, mB)).toEqual([]);
    expect((await returns.listAllAvailableCredits(actor, mA)).length).toBe(1);
    expect(await returns.listAllAvailableCredits(actor, mB)).toEqual([]);

    await expect(returns.applyCreditToInvoice(credit!.id, seeded.A.invoiceId, '50.00', actor, mB)).rejects.toThrow(); // A's invoice is unknown to B
    const applied = await returns.applyCreditToInvoice(credit!.id, seeded.A.invoiceId, '50.00', actor, mA);
    expect(applied.remainingAmount).toBe('150.00');
    expect((await mA.query(`SELECT count(*)::int n FROM customer_ledger_entries WHERE "entryType" = 'return_credit_note' AND "invoiceId" = $1`, [seeded.A.invoiceId]))[0].n).toBe(1);
    expect((await mB.query(`SELECT count(*)::int n FROM customer_ledger_entries`))[0].n).toBe(0);
  });

  it('Test F — nothing leaked into the other Company\'s credits', async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await dsB.query(`SELECT count(*)::int n FROM return_credits`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM return_dispositions`))[0].n).toBe(0);
  });
});
