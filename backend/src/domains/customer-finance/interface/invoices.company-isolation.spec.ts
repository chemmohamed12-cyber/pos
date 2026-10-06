import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { InvoiceService } from '../application/invoices.service';
import { CustomerLedgerService } from '../application/customer-ledger.service';
import { CustomersService } from '../../crm/application/customers.service';
import { TaxEngineService } from '../../accounting/application/tax-engine.service';
import { TaxCodeService } from '../../accounting/application/tax-code.service';
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
 * Area 21 (2026-10-05, CTO-authorized) — real-Postgres Company isolation for `invoices.controller.ts` (Matrix §24: it was
 * blocked on the Tax Engine, which is now Company-capable). Two real Company databases, the real Tax Engine / Tax Code /
 * Customer Ledger / Process Engine; only the Sales-Orders READ contract is a thin accessor over each Company's own
 * `sales_orders` tables (the order domain is not under test here). A draft invoice freezes its tax from the Company's own
 * tax codes, posts into the Company's own ledger and outbox, and a void reverses inside the same Company.
 */
describe('InvoicesController Area 21 retrofit — real-Postgres Company isolation', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let invoices: InvoiceService;
  let taxCodes: TaxCodeService;
  const actor = randomUUID();
  const seeded: Record<'A' | 'B', { customerId: string; orderId: string; lineTotal: string }> = {
    A: { customerId: '', orderId: '', lineTotal: '200.00' },
    B: { customerId: '', orderId: '', lineTotal: '500.00' },
  };

  async function seed(companyId: string, key: 'A' | 'B') {
    const ds = await h.connections.getDataSource(companyId);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [actor, 'Invoice Isolation Admin', `iso-inv-${companyId}@test.local`]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actor, role[0].id]);
    const customerId = randomUUID();
    const orderId = randomUUID();
    const productId = randomUUID();
    const qty = key === 'A' ? 2 : 5;
    const unit = key === 'A' ? '100.00' : '100.00';
    await ds.query(`INSERT INTO "customers" ("id","code","name","creditLimit","paymentTermsDays") VALUES ($1,$2,$3,'100000.00',30)`, [customerId, `CUST-INV-${key}`, `${key} Customer`]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'100.00','active')`, [productId, `SKU-INV-${key}`, `${key} Product`]);
    await ds.query(
      `INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount","repSequenceNumber","createdByUserId") VALUES ($1,$2,$3,$4,$5,1,$4)`,
      [orderId, `SO-INV-${key}`, customerId, actor, seeded[key].lineTotal],
    );
    await ds.query(
      `INSERT INTO "sales_order_lines" ("id","salesOrderId","productId","quantity","unitPrice","listPrice","discountAmount","lineTotal") VALUES ($1,$2,$3,$4,$5,$5,'0.00',$6)`,
      [randomUUID(), orderId, productId, qty, unit, seeded[key].lineTotal],
    );
    seeded[key] = { ...seeded[key], customerId, orderId };
  }

  /** A thin READ accessor over the CALLER's own Company tables — an order id of another Company is simply unknown. */
  const salesOrders: SalesOrdersReadContract = {
    async getOrder(orderId: string, _user: string, manager?: EntityManager) {
      const [row] = await manager!.query(`SELECT "customerId","warehouseId" FROM sales_orders WHERE id = $1`, [orderId]);
      if (!row) throw new NotFoundException(`Sales order "${orderId}" not found.`);
      return row;
    },
    async getOrderLines(orderId: string, manager?: EntityManager) {
      return manager!.query(`SELECT id,"productId",quantity,"unitPrice"::text AS "unitPrice","discountAmount"::text AS "discountAmount","lineTotal"::text AS "lineTotal" FROM sales_order_lines WHERE "salesOrderId" = $1`, [orderId]);
    },
  } as unknown as SalesOrdersReadContract;

  let invoiceA = '';
  let invoiceB = '';
  let taxCodeA = '';

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'invoices_isolation', extraCompanyTags: ['sales', 'finance', 'accounting'] });
    await seed(h.companyAId, 'A');
    await seed(h.companyBId, 'B');
    const dsA = await h.connections.getDataSource(h.companyAId);
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert, h.connections);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const customers = new CustomersService(h.controlPlane, inert, inert, inert, inert, authorization, inert, inert);
    const ledger = new CustomerLedgerService(h.controlPlane, numbering, audit, customers);
    const taxEngine = new TaxEngineService(h.controlPlane, { get: () => null } as never);
    taxCodes = new TaxCodeService(h.controlPlane, audit);
    invoices = new InvoiceService(h.controlPlane, numbering, processEngine, audit, salesOrders, customers, ledger, events, taxEngine);
  });

  afterAll(async () => {
    await h.teardown();
  });

  const mgr = async (id: string) => (await h.connections.getDataSource(id)).manager;

  it('a draft invoice freezes tax from the Company\'s OWN tax codes — another Company\'s tax code id is unresolvable (no tax), never read', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    taxCodeA = (await taxCodes.createTaxCode({ code: 'VAT10', name: 'VAT 10', rate: '10' }, actor, mA)).id;
    expect((await taxCodes.listTaxCodes(mA)).map((t) => t.code)).toEqual(['VAT10']);
    expect(await taxCodes.listTaxCodes(mB)).toEqual([]);

    const dA = await invoices.createDraftInvoice(seeded.A.orderId, actor, taxCodeA, mA);
    invoiceA = dA.id;
    expect(dA.totalAmount).toBe('200.00');
    expect(dA.taxAmount).toBe('20.00');
    expect(dA.taxCodeId).toBe(taxCodeA);

    await expect(invoices.createDraftInvoice(seeded.A.orderId, actor, taxCodeA, mB)).rejects.toBeInstanceOf(NotFoundException); // A's order is unknown to B
    const dB = await invoices.createDraftInvoice(seeded.B.orderId, actor, taxCodeA, mB); // A's tax code id means nothing in B
    invoiceB = dB.id;
    expect(dB.taxAmount).toBe('0.00');
    expect(dB.taxCodeId).toBeNull();
    expect(dA.invoiceNumber).toMatch(/^INV/);
  });

  it('posting writes the AR debit and the outbox event into the Company\'s own database only', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    await expect(invoices.postInvoice(invoiceA, actor, mB)).rejects.toBeInstanceOf(NotFoundException);
    const posted = await invoices.postInvoice(invoiceA, actor, mA);
    expect(posted.postedByUserId).toBe(actor);
    expect((await invoices.getInvoice(invoiceA, actor, mA)).state).toBe('posted');
    expect((await invoices.getInvoice(invoiceA, actor, mA)).remaining).toBe('220.00'); // gross = net + tax
    expect((await mA.query(`SELECT count(*)::int n FROM customer_ledger_entries WHERE "invoiceId" = $1 AND direction = 'debit'`, [invoiceA]))[0].n).toBe(1);
    expect((await mB.query(`SELECT count(*)::int n FROM customer_ledger_entries`))[0].n).toBe(0);
    expect((await mA.query(`SELECT count(*)::int n FROM event_outbox WHERE topic LIKE '%invoice%posted%'`))[0].n).toBe(1);
    expect((await mB.query(`SELECT count(*)::int n FROM event_outbox WHERE topic LIKE '%invoice%posted%'`))[0].n).toBe(0);
  });

  it('lists, per-order lookup and AR ageing are Company-local', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    expect((await invoices.listAllInvoices(actor, mA)).map((i) => i.id)).toEqual([invoiceA]);
    expect((await invoices.listAllInvoices(actor, mB)).map((i) => i.id)).toEqual([invoiceB]);
    expect((await invoices.getInvoiceForSalesOrder(seeded.A.orderId, actor, mA))?.id).toBe(invoiceA);
    await expect(invoices.getInvoice(invoiceA, actor, mB)).rejects.toBeInstanceOf(NotFoundException);
    expect((await invoices.getArAgingForAllCustomers(actor, mA)).map((r) => r.invoiceId)).toEqual([invoiceA]);
    expect((await invoices.getArAgingForAllCustomers(actor, mB)).map((r) => r.invoiceId)).toEqual([]); // B's invoice is still a draft
  });

  it('voiding a posted invoice reverses its AR entry inside the same Company', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    await expect(invoices.voidInvoice(invoiceA, 'nope', actor, mB)).rejects.toBeInstanceOf(NotFoundException);
    await invoices.voidInvoice(invoiceA, 'customer cancelled', actor, mA);
    expect((await invoices.getInvoice(invoiceA, actor, mA)).state).toBe('void');
    expect((await mA.query(`SELECT count(*)::int n FROM customer_ledger_entries WHERE "invoiceId" = $1`, [invoiceA]))[0].n).toBe(2); // debit + reversal
    expect((await invoices.getInvoice(invoiceB, actor, mB)).state).toBe('draft'); // B untouched
  });
});
