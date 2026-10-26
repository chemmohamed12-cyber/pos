import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { ReportsService } from '../application/reports.service';
import { CustomerAccountsService } from '../application/customer-accounts.service';
import { DeliveryService } from '../../delivery/application/delivery.service';
import { ReturnsService } from '../../returns/application/returns.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { UsersService } from '../../../foundation/identity/users.service';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `reports.controller.ts` — a pure cross-domain
 * *aggregator* — routes every one of its reads through the Company
 * manager. Two real, separately provisioned Company databases with
 * deliberately different figures (orders 245.00 vs 900.00, COD pending
 * 300.00 vs 450.00, a return with a 40.00 credit only in Company A).
 *
 * `DeliveryService` and `ReturnsService` are the *real* implementations
 * (constructed with an inert ambient DataSource, so a missed manager
 * crashes) — they carry this retrofit's own concrete changes
 * (`listAllCollections`, `listReturns`/`getStatus`/`getCreditForReturnRequest`).
 * The already-proven Sales/Shipment/Finance contracts are stubs that read
 * through the manager they are handed and **throw if given none**; their
 * own Company-isolation is proven by §16/§25/§29. Platform identity
 * (`UsersService`, display names only) is intentionally a stub: it is a
 * Platform read by design, recorded for Gate A/C.
 */
describe('ReportsController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let reports: ReportsService;
  let accounts: CustomerAccountsService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { customerId: string }> = { A: { customerId: '' }, B: { customerId: '' } };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', code: string, total: string, collectionAmount: string, withReturn: boolean) {
    const ds = await h.connections.getDataSource(companyId);
    const customerId = randomUUID();
    const warehouseId = randomUUID();
    const productId = randomUUID();
    const orderId = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [actorUserId, 'Isolation Test Rep', `iso-rep-${companyId}@test.local`]);
    await ds.query(`INSERT INTO "customers" ("id","code","name") VALUES ($1,$2,$3)`, [customerId, `CUST-${code}`, `${code} Customer`]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$3,'active')`, [warehouseId, `WH-${code}`, `${code} Warehouse`]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'10.00','active')`, [productId, `SKU-${code}`, `${code} Product`]);
    await ds.query(
      `INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount","warehouseId") VALUES ($1,$2,$3,$4,$5,$6)`,
      [orderId, `SO-RPT-${code}`, customerId, actorUserId, total, warehouseId],
    );
    await ds.query(
      `INSERT INTO "customer_ledger_entries" ("id","entryNumber","customerId","entryType","direction","amount","entryDate","createdByUserId") VALUES ($1,$2,$3,'sales_invoice','debit',$4,now(),$5)`,
      [randomUUID(), `CLE-RPT-${code}`, customerId, total, actorUserId],
    );

    // Custodian (shipping company + custody account) and one pending COD collection.
    const custodyType: Array<{ id: string }> = await ds.query(`SELECT id FROM "treasury_account_types" WHERE "code" = 'custody'`);
    const custodyAccountId = randomUUID();
    await ds.query(`INSERT INTO "treasury_accounts" ("id","code","name","accountTypeId","status") VALUES ($1,$2,'Custody',$3,'active')`, [custodyAccountId, `CUST-${code}`, custodyType[0].id]);
    await ds.query(`INSERT INTO "shipping_companies" ("id","code","name","custodyAccountId","status") VALUES ($1,$2,$3,$4,'active')`, [randomUUID(), `SC-${code}`, `${code} Shipping Co`, custodyAccountId]);
    await ds.query(
      `INSERT INTO "collections" ("id","shipmentId","amount","method","collectorUserId","custodyAccountId") VALUES ($1,$2,$3,'cash',$4,$5)`,
      [randomUUID(), randomUUID(), collectionAmount, actorUserId, custodyAccountId],
    );

    if (withReturn) {
      const returnId = randomUUID();
      await ds.query(
        `INSERT INTO "return_requests" ("id","salesOrderId","productId","quantity","warehouseId","reason","requestedByUserId") VALUES ($1,$2,$3,1,$4,'damaged',$5)`,
        [returnId, orderId, productId, warehouseId, actorUserId],
      );
      await ds.query(
        `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'return_request','return_request',$2,'requested')`,
        [randomUUID(), returnId],
      );
      await ds.query(
        `INSERT INTO "return_credits" ("id","returnRequestId","customerId","originalSalesOrderId","originalAmount","remainingAmount") VALUES ($1,$2,$3,$4,'40.00','40.00')`,
        [randomUUID(), returnId, customerId, orderId],
      );
    }
    seeded[key] = { customerId };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'rpt_isolation', extraCompanyTags: ['sales', 'inventory', 'finance', 'logistics'] });
    await seedCompanyData(h.companyAId, 'A', 'A', '245.00', '300.00', true);
    await seedCompanyData(h.companyBId, 'B', 'B', '900.00', '450.00', false);

    const inert = {} as never;
    const need = (manager?: EntityManager): EntityManager => {
      if (!manager) throw new Error('contract called without the Company manager');
      return manager;
    };
    const processEngine = new ProcessEngineService(h.controlPlane);
    const delivery = new DeliveryService(inert, inert, inert, inert, inert, inert, inert, inert, inert, inert, inert);
    const returns = new ReturnsService(inert, processEngine, inert, inert, inert, inert, inert, inert, inert, inert, inert, inert, inert);

    const salesOrders = {
      listOrders: async (_u: string, manager?: EntityManager) =>
        need(manager).query(`SELECT "id","orderNumber","createdAt","customerId","salesRepUserId","workflowPolicy","totalAmount" FROM "sales_orders" ORDER BY "createdAt"`),
      getOrderStatus: async (_id: string, manager?: EntityManager) => {
        need(manager);
        return 'draft';
      },
    };
    const customers = {
      listCustomers: async (_u: string, manager?: EntityManager) => need(manager).query(`SELECT "id","code","name" FROM "customers"`),
      getCustomer: async (id: string, _u: string, manager?: EntityManager) => {
        const rows: Array<{ id: string; code: string; name: string }> = await need(manager).query(`SELECT "id","code","name" FROM "customers" WHERE "id" = $1`, [id]);
        if (rows.length === 0) throw new Error(`Customer "${id}" not found.`);
        return rows[0];
      },
    };
    const deposits = {
      getLatestDepositForOrder: async (_id: string, _u: string, manager?: EntityManager) => {
        need(manager);
        return null;
      },
      listDepositsForOrder: async (_id: string, _u: string, manager?: EntityManager) => {
        need(manager);
        return [];
      },
    };
    const shipments = {
      listShippingCompanies: async (manager?: EntityManager) => need(manager).query(`SELECT "id","code","name","custodyAccountId" FROM "shipping_companies"`),
      listVehicles: async (manager?: EntityManager) => {
        need(manager);
        return [];
      },
      getCustodianOverview: async (_t: string, _id: string, manager?: EntityManager) => {
        need(manager);
        return { custodyBalance: '0.00', activeShipmentsCount: 0 };
      },
      getShipmentByFulfillmentOrderId: async (_id: string, manager?: EntityManager) => {
        need(manager);
        return null;
      },
    };
    const fulfillment = {
      getFulfillmentOrderBySalesOrderId: async (_id: string, manager?: EntityManager) => {
        need(manager);
        return null;
      },
    };
    const customerLedger = {
      listLedger: async (id: string, _f: unknown, manager?: EntityManager) =>
        need(manager).query(
          `SELECT "amount","direction","status","entryType","entryDate","entryNumber","reason","salesOrderId","invoiceId" FROM "customer_ledger_entries" WHERE "customerId" = $1`,
          [id],
        ),
      getCreditSummary: async (id: string, manager?: EntityManager) => {
        const rows: Array<{ bal: string }> = await need(manager).query(
          `SELECT COALESCE(SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END),0)::text AS bal FROM "customer_ledger_entries" WHERE "customerId" = $1`,
          [id],
        );
        return { balance: rows[0].bal, creditLimit: null, availableCredit: null, overdueAmount: '0.00' };
      },
    };
    const users = { findById: async () => ({ fullName: 'Rep' }) } as unknown as UsersService;

    reports = new ReportsService(salesOrders as never, customers as never, deposits as never, users, shipments as never, delivery);
    accounts = new CustomerAccountsService(
      salesOrders as never,
      customers as never,
      deposits as never,
      returns,
      fulfillment as never,
      shipments as never,
      delivery,
      customerLedger as never,
    );
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("getSalesOrdersReport via Company A returns only A's order/customer; via Company B only B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const a = await reports.getSalesOrdersReport(actorUserId, dsA.manager);
    const b = await reports.getSalesOrdersReport(actorUserId, dsB.manager);
    expect(a.map((r) => [r.orderNumber, r.customerName, r.totalAmount])).toEqual([['SO-RPT-A', 'A Customer', '245.00']]);
    expect(b.map((r) => [r.orderNumber, r.customerName, r.totalAmount])).toEqual([['SO-RPT-B', 'B Customer', '900.00']]);
  });

  it('getSalesByCustomer / getSalesByPeriod / getSalesByRep aggregate only the owning Company (245.00 vs 900.00)', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await reports.getSalesByCustomer(actorUserId, dsA.manager)).map((r) => r.totalAmount)).toEqual(['245.00']);
    expect((await reports.getSalesByCustomer(actorUserId, dsB.manager)).map((r) => r.totalAmount)).toEqual(['900.00']);
    expect((await reports.getSalesByPeriod(actorUserId, 'month', dsA.manager)).map((r) => r.totalAmount)).toEqual(['245.00']);
    expect((await reports.getSalesByRep(actorUserId, dsB.manager)).map((r) => r.totalAmount)).toEqual(['900.00']);
  });

  it("getCustodyCodReport (real DeliveryService.listAllCollections) shows only the owning Company's COD (A 300.00 pending, B 450.00)", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const a = await reports.getCustodyCodReport(dsA.manager);
    const b = await reports.getCustodyCodReport(dsB.manager);
    expect(a.rows.map((r) => [r.custodianCode, r.codPendingTotal])).toEqual([['SC-A', '300.00']]);
    expect(b.rows.map((r) => [r.custodianCode, r.codPendingTotal])).toEqual([['SC-B', '450.00']]);
    expect([a.totals.codCollectedTotal, b.totals.codCollectedTotal]).toEqual(['300.00', '450.00']);
  });

  it("getCustomerAccountStatement for each Company's customer resolves only its own ledger balance (245.00 vs 900.00)", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const a = await accounts.getCustomerAccountStatement(seeded.A.customerId, actorUserId, dsA.manager);
    const b = await accounts.getCustomerAccountStatement(seeded.B.customerId, actorUserId, dsB.manager);
    expect([a.customerName, a.balance, a.totalSales]).toEqual(['A Customer', '245.00', '245.00']);
    expect([b.customerName, b.balance, b.totalSales]).toEqual(['B Customer', '900.00', '900.00']);
  });

  it("getCustomerAccountReconciliation (real ReturnsService reads) shows A's 40.00 return credit and none for B", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const a = await accounts.getCustomerAccountReconciliation(seeded.A.customerId, actorUserId, dsA.manager);
    const b = await accounts.getCustomerAccountReconciliation(seeded.B.customerId, actorUserId, dsB.manager);
    expect(a.returnCount).toBe(1);
    expect(a.entries.filter((e) => e.type === 'return').map((e) => [e.amount, e.status])).toEqual([['40.00', 'requested']]);
    expect(b.returnCount).toBe(0);
    expect(a.totalOrdered).toBe('245.00');
    expect(b.totalOrdered).toBe('900.00');
  });

  it("a statement for Company A's customer id through Company B's manager is rejected (A→B DENY)", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(accounts.getCustomerAccountStatement(seeded.A.customerId, actorUserId, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(accounts.getCustomerAccountReconciliation(seeded.A.customerId, actorUserId, dsB.manager)).rejects.toThrow(/not found/i);
  });

  it("Test F — resolving Company A's reports never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await reports.getSalesOrdersReport(actorUserId, dsA.manager);
      await reports.getCustodyCodReport(dsA.manager);
      await accounts.getCustomerAccountStatement(seeded.A.customerId, actorUserId, dsA.manager);
      await accounts.getCustomerAccountReconciliation(seeded.A.customerId, actorUserId, dsA.manager);
    });
  });
});
