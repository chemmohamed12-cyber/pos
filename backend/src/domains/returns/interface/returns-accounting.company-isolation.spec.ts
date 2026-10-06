import { randomUUID } from 'crypto';
import { SalesReturnsService } from '../application/sales-returns.service';
import { ShipmentReturnsService } from '../application/shipment-returns.service';
import { ReturnFinancialsService } from '../application/return-financials.service';
import { OrderLineReturnCapacityService } from '../application/order-line-return-capacity.service';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { CustomersService } from '../../crm/application/customers.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { InventoryValuationService } from '../../inventory-valuation/application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../../inventory-valuation/application/moving-average-cost-engine.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { InvoiceService } from '../../customer-finance/application/invoices.service';
import { SalesInvoice } from '../../customer-finance/infrastructure/sales-invoice.entity';
import { SalesInvoiceLine } from '../../customer-finance/infrastructure/sales-invoice-line.entity';
import { SALES_INVOICE_PROCESS } from '../../customer-finance/domain/sales-invoice-process';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../../accounting/application/journal-entry.service';
import { FinancialEventService } from '../../accounting/application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../../accounting/application/financial-events/handler-registry';
import { InventoryCostingHandlerService } from '../../accounting/application/financial-events/inventory-costing-handler.service';
import { InventoryPostingPolicyService } from '../../accounting/application/inventory-posting-policy.service';
import { GLAccountService } from '../../accounting/application/gl-account.service';
import { FiscalPeriodService } from '../../accounting/application/fiscal-period.service';
import { CurrencyService } from '../../accounting/application/currency.service';
import { FinancialDimensionService } from '../../accounting/application/financial-dimension.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { AR_EVENT_TOPICS } from '../../../foundation/module-registry/contracts/ar-events.contract';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * D4 (2026-10-05, CTO-approved Returns accounting policy) — real-Postgres proof, Company A with Company B as the untouched
 * witness. The full chain is real: Company-owned outbox → financial events → posting gate → GL; the real moving-average
 * valuation; the real Customer Ledger / invoice services; the real Sales/Shipment return services and the shared
 * `ReturnFinancialsService`. The ambient (control-plane) connection has only `core` tables and an inert outbox.
 *
 * The ORIGINAL sale is built through the same code paths production uses: stock receipts at a known cost, `dispatch`
 * movements referenced to the Sales Order (their GL events consume cost at 4.00/unit), then the average cost is moved to 6.40
 * on purpose — so a return that used "the current average" would visibly mis-state COGS. Invoices are posted through the real
 * ledger + `finance.invoice.posted` event (Dr AR / Cr Revenue / Cr tax).
 */
describe('D4 — returns accounting (inventory/COGS, Revenue/AR/tax reversal, customer credit) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let inventory: InventoryService;
  let events: EventBusService;
  let financialEvents: FinancialEventService;
  let salesReturns: SalesReturnsService;
  let shipmentReturns: ShipmentReturnsService;
  let ledger: CustomerLedgerService;
  let invoices: InvoiceService;
  let processEngine: ProcessEngineService;
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';

  const config: Record<string, unknown> = {
    'accounting.inventory_cogs_account_code': '5101',
    'accounting.sales_returns_account_code': '4102',
    'logistics.sales_return_eligibility_window_days': 365,
  };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  const ids = {
    warehouse: randomUUID(),
    product: randomUUID(),
    custInvoiced: randomUUID(), // O1 + O3 (invoiced)
    custPlain: randomUUID(), // O2 (never invoiced)
    custNoCost: randomUUID(), // O4 (never dispatched)
    o1: { order: randomUUID(), line: randomUUID(), shipment: randomUUID(), shipmentLine: randomUUID(), invoice: '' },
    o2: { order: randomUUID(), line: randomUUID(), shipment: randomUUID(), shipmentLine: randomUUID() },
    o3: { order: randomUUID(), line: randomUUID(), shipment: randomUUID(), shipmentLine: randomUUID(), invoice: '' },
    o4: { order: randomUUID(), line: randomUUID(), shipment: randomUUID(), shipmentLine: randomUUID() }, // shipped, but never dispatched/costed
    o5: { order: randomUUID(), line: randomUUID(), shipment: randomUUID(), shipmentLine: randomUUID() }, // shipped, no restock warehouse
  };

  async function seedCompany(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'D4 Operator',$2) ON CONFLICT DO NOTHING`, [actor, `d4-${k}@test.local`]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actor, role[0].id]);
    for (const [code, name, type, normal, fn] of [
      ['1110', 'Accounts Receivable', 'asset', 'debit', 'ar'],
      ['1120', 'Inventory', 'asset', 'debit', 'inventory'],
      ['2120', 'Output Tax Payable', 'liability', 'credit', 'tax_payable'],
      ['3105', 'Opening Balance Equity', 'equity', 'credit', null],
      ['4101', 'Sales Revenue', 'revenue', 'credit', null],
      ['4102', 'Sales Returns', 'revenue', 'debit', null],
      ['5101', 'Cost of Goods Sold', 'expense', 'debit', null],
    ] as Array<[string, string, string, string, string | null]>) {
      await ds.query(
        `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`,
        [randomUUID(), code, name, type, normal, fn],
      );
    }
    const fy = randomUUID();
    const fp = randomUUID();
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fy, randomUUID(), fp],
    );
    await new NumberingService(h.controlPlane).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
  }

  /** The (Company A only) sales fixtures: customers, warehouse, product, five orders, shipments. */
  async function seedSales() {
    const ds = await dsOf('A');
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-A','Main','active')`, [ids.warehouse]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-D4','D4 Product','10.00','active')`, [ids.product]);
    for (const [id, code] of [[ids.custInvoiced, 'INV'], [ids.custPlain, 'PLAIN'], [ids.custNoCost, 'NOCOST']] as Array<[string, string]>) {
      await ds.query(`INSERT INTO "customers" ("id","code","name") VALUES ($1,$2,$3)`, [id, `CUST-${code}`, `${code} Customer`]);
    }
    const order = async (o: { order: string; line: string }, cust: string, qty: number, unit: string, total: string, wh: string | null, shipment?: { shipment: string; shipmentLine: string }) => {
      await ds.query(
        `INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount","warehouseId") VALUES ($1,$2,$3,$4,$5,$6)`,
        [o.order, `SO-${o.order.slice(0, 8)}`, cust, actor, total, wh],
      );
      await ds.query(
        `INSERT INTO "sales_order_lines" ("id","salesOrderId","productId","quantity","unitPrice","listPrice","lineTotal") VALUES ($1,$2,$3,$4,$5,$5,$6)`,
        [o.line, o.order, ids.product, qty, unit, total],
      );
      if (shipment) {
        await ds.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","salesOrderId") VALUES ($1,$2,$3,$4)`, [shipment.shipment, randomUUID(), `WB-${shipment.shipment.slice(0, 8)}`, o.order]);
        await ds.query(
          `INSERT INTO "shipment_lines" ("id","shipmentId","salesOrderLineId","productId","quantity","unitPrice","lineTotal") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [shipment.shipmentLine, shipment.shipment, o.line, ids.product, qty, unit, total],
        );
      }
    };
    await order(ids.o1, ids.custInvoiced, 10, '10.00', '100.00', ids.warehouse, ids.o1);
    await order(ids.o2, ids.custPlain, 5, '12.00', '60.00', ids.warehouse, ids.o2);
    await order(ids.o3, ids.custInvoiced, 4, '25.00', '100.00', ids.warehouse, ids.o3);
    await order(ids.o4, ids.custNoCost, 3, '10.00', '30.00', ids.warehouse, ids.o4);
    await order(ids.o5, ids.custNoCost, 3, '10.00', '30.00', null, ids.o5);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'd4_returns', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting', 'logistics'] });

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    events = new EventBusService(inert, h.connections);
    processEngine = new ProcessEngineService(h.controlPlane);
    const cfg = { get: (key: string) => config[key] } as unknown as ConfigurationEngineService;
    const currencies = new CurrencyService(h.controlPlane, audit);
    const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, cfg, dimensions);

    const valuation = new InventoryValuationService(new MovingAverageCostEngine(h.controlPlane));
    const handlerRegistry = new FinancialEventHandlerRegistry();
    financialEvents = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, handlerRegistry, cfg);
    financialEvents.onModuleInit();
    new InventoryCostingHandlerService(handlerRegistry, valuation).onModuleInit();

    const policyRegistry = new InventoryPostingPolicyRegistry();
    new InventoryPostingPolicyService(cfg, policyRegistry).onModuleInit();

    const dsA0 = await dsOf('A');
    const authorization = new AuthorizationService(dsA0.getRepository(Role), dsA0.getRepository(UserRole));
    const salesOrders = new SalesOrdersService(inert, inert, inert, inert, authorization, inert, inert, inert, inert, inert, inert);
    const customers = new CustomersService(inert, inert, inert, inert, inert, inert, inert, inert);
    const shipments = new ShipmentService(inert, inert, inert, inert, inert, inert, inert, inert, inert, inert, inert, inert);
    inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, events, valuation as never, policyRegistry);
    ledger = new CustomerLedgerService(h.controlPlane, numbering, audit, customers);
    invoices = new InvoiceService(h.controlPlane, numbering, processEngine, audit, salesOrders, customers, ledger, events, inert);
    const financials = new ReturnFinancialsService(inventory, salesOrders, ledger, invoices, events, policyRegistry);
    const capacity = new OrderLineReturnCapacityService();
    const returnsConfig = { get: (k: string) => config[k] } as unknown as ConfigurationEngineService;
    salesReturns = new SalesReturnsService(h.controlPlane, processEngine, audit, numbering, returnsConfig, inventory, salesOrders, customers, capacity, financials, events);
    shipmentReturns = new ShipmentReturnsService(h.controlPlane, processEngine, audit, numbering, inventory, salesOrders, customers, shipments, capacity, financials, events);

    await seedCompany('A');
    await seedCompany('B');
    await seedSales();
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('D4 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---------------- helpers ----------------
  const flush = async (k: Key) => events.dispatchAfterCommit((await dsOf(k)).manager);
  const count = async (k: Key, table: string) => Number((await (await dsOf(k)).query(`SELECT count(*) AS n FROM "${table}"`))[0].n);

  async function snapshot(k: Key) {
    const ds = await dsOf(k);
    return {
      stock: await count(k, 'stock_movements'),
      valuation: await ds.query(`SELECT "warehouseId","onHandQuantity"::text AS q,"totalValueBase"::text AS v FROM "inventory_valuation_state" ORDER BY 1`),
      valuationMoves: await count(k, 'inventory_valuation_movements'),
      outbox: await count(k, 'event_outbox'),
      financialEvents: await count(k, 'accounting_financial_events'),
      journals: await count(k, 'accounting_journal_entries'),
      ledger: await count(k, 'customer_ledger_entries'),
    };
  }
  async function lines(k: Key, journalEntryId: string): Promise<string[]> {
    const rows: Array<{ code: string; dr: string; cr: string }> = await (await dsOf(k)).query(
      `SELECT ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY ga.code`,
      [journalEntryId],
    );
    return rows.map((r) => (Number(r.dr) > 0 ? `${r.code} D ${Number(r.dr).toFixed(2)}` : `${r.code} C ${Number(r.cr).toFixed(2)}`));
  }
  /** The financial events of a kind that reference a given return document. */
  async function eventsFor(k: Key, topic: string, referenceId: string) {
    const ds = await dsOf(k);
    const col = topic === 'inventory.movement.recorded' ? `fe.payload->>'referenceId'` : `fe.payload->>'returnId'`;
    return ds.query(
      `SELECT fe.status, fe."rejectionReason", fe."journalEntryId", fe.id FROM "accounting_financial_events" fe WHERE fe."eventType" = $1 AND ${col} = $2 ORDER BY fe."receivedAt"`,
      [topic, referenceId],
    ) as Promise<Array<{ status: string; rejectionReason: string | null; journalEntryId: string | null; id: string }>>;
  }
  const valuationOf = async (k: Key) => {
    const rows = await (await dsOf(k)).query(`SELECT coalesce(sum("onHandQuantity"),0)::int AS q, coalesce(sum("totalValueBase"),0)::text AS v FROM "inventory_valuation_state"`);
    return { qty: Number(rows[0].q), value: Number(rows[0].v) };
  };
  const glBalance = async (k: Key, code: string) =>
    Number(
      (await (await dsOf(k)).query(
        `SELECT coalesce(sum(jl."debitBase" - jl."creditBase"), 0)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE ga.code = $1`,
        [code],
      ))[0].b,
    );
  const ledgerBalance = async (customerId: string) => Number(await ledger.getCustomerBalance(customerId, (await dsOf('A')).manager));
  const stateOf = async (def: Parameters<ProcessEngineService['getState']>[0], type: string, id: string) => processEngine.getState(def, type, id, (await dsOf('A')).manager);

  async function dispatchOrder(orderId: string, qty: number) {
    const ds = await dsOf('A');
    await inventory.recordMovement(ids.warehouse, ids.product, -qty, 'dispatch', 'sales_order', orderId, actor, ds.manager);
    await flush('A');
  }

  async function postInvoice(o: { order: string; line: string; invoice: string }, customerId: string, qty: number, unit: string, net: string, tax: string, number: string) {
    const ds = await dsOf('A');
    const m = ds.manager;
    const gross = (Number(net) + Number(tax)).toFixed(2);
    const inv = await m.getRepository(SalesInvoice).save(
      m.getRepository(SalesInvoice).create({
        invoiceNumber: number, customerId, salesOrderId: o.order, shipmentId: null, subtotal: net, discountAmount: '0.00', taxAmount: tax, taxCodeId: null,
        totalAmount: net, dueDate: null, createdByUserId: actor, postedByUserId: actor, voidedReason: null,
      }),
    );
    await m.getRepository(SalesInvoiceLine).save(
      m.getRepository(SalesInvoiceLine).create({ salesInvoiceId: inv.id, salesOrderLineId: o.line, productId: ids.product, quantity: qty, unitPrice: unit, discountAmount: '0.00', lineTotal: net }),
    );
    await processEngine.start(SALES_INVOICE_PROCESS, 'sales_invoice', inv.id, m);
    await processEngine.transition(SALES_INVOICE_PROCESS, 'sales_invoice', inv.id, 'post', actor, m);
    await ledger.postEntry({ customerId, entryType: 'sales_invoice', direction: 'debit', amount: gross, salesOrderId: o.order, invoiceId: inv.id, reference: number, reason: 'Sales invoice posted', createdByUserId: actor }, m);
    await events.publish(m, AR_EVENT_TOPICS.invoicePosted, {
      idempotencyKey: `d4:invoice:${inv.id}:posted`, businessDate: today, orgUnitId: null, currency: 'EGP', sourceEntityType: 'invoice', sourceEntityId: inv.id,
      externalDocument: null, payloadVersion: 1, invoiceId: inv.id, invoiceNumber: number, customerId, salesOrderId: o.order,
      netAmount: net, taxAmount: tax, taxAccountCode: Number(tax) > 0 ? '2120' : null, grossAmount: gross, dueDate: null,
    });
    await flush('A');
    o.invoice = inv.id;
  }

  async function newSalesReturn(customerId: string, orderLineId: string, qty: number, price = '10.00') {
    const ds = await dsOf('A');
    return salesReturns.createSalesReturn(customerId, null, new Date(), [{ sourceSalesOrderLineId: orderLineId, returnQuantity: qty, returnPrice: price }], 'd4', actor, ds.manager);
  }
  async function newShipmentReturn(shipmentId: string, shipmentLineId: string, qty: number) {
    const ds = await dsOf('A');
    return shipmentReturns.createShipmentReturn(shipmentId, 'partial', [{ shipmentLineId, returnQuantity: qty, returnPrice: '10.00' }], 'd4', actor, ds.manager);
  }

  // ---------------- the original sales ----------------
  it('0. SETUP — original sales through real paths: receipt @4.00, dispatches of O1/O2/O3 costed at 4.00, then the average is moved to 6.40; O1/O3 invoiced', async () => {
    const ds = await dsOf('A');
    await inventory.recordMovement(ids.warehouse, ids.product, 40, 'receipt', 'goods_receipt', randomUUID(), actor, ds.manager, '4.00'); // GR-style: valuation only
    await dispatchOrder(ids.o1.order, 10);
    await dispatchOrder(ids.o2.order, 5);
    await dispatchOrder(ids.o3.order, 4);
    expect(await valuationOf('A')).toEqual({ qty: 21, value: 84 });
    await inventory.recordMovement(ids.warehouse, ids.product, 9, 'receipt', 'goods_receipt', randomUUID(), actor, ds.manager, '14.00'); // 21@4 + 9@14 → avg 7.00
    expect((await valuationOf('A')).value).toBeCloseTo(84 + 126, 4);
    await postInvoice(ids.o1, ids.custInvoiced, 10, '10.00', '100.00', '14.00', 'INV-D4-1'); // AR 114
    await postInvoice(ids.o3, ids.custInvoiced, 4, '25.00', '100.00', '0.00', 'INV-D4-3'); // AR 100, no tax
    expect(await ledgerBalance(ids.custInvoiced)).toBe(214);
    expect(await glBalance('A', '1110')).toBeCloseTo(214, 4);
  });

  // ---------------- Sales Return of an INVOICED sale ----------------
  let sr1: { id: string; returnNumber: string };
  it('1/3/4/5/6/7. SALES RETURN linked to O1 (4 of 10): stock restored at the ORIGINAL cost 4.00 (not the 7.00 average) → Dr 1120 16 / Cr COGS 16; Revenue/AR/tax reversed from the ORIGINAL invoice value → Dr 4102 40 + Dr 2120 5.60 / Cr AR 45.60; customer credit 45.60', async () => {
    const dsA = await dsOf('A');
    const before = await valuationOf('A');
    // declared return price (9.00) deliberately differs from the original unit net (10.00): the GL uses the ORIGINAL value (CTO policy)
    sr1 = await newSalesReturn(ids.custInvoiced, ids.o1.line, 4, '9.00');
    const detail = await salesReturns.getSalesReturnDetail(sr1.id, dsA.manager);
    expect(detail.lines[0].sourceSalesOrderId).toBe(ids.o1.order); // 1. linked to the original order …
    expect(detail.lines[0].sourceSalesOrderLineId).toBe(ids.o1.line); // … and order line

    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      expect(await salesReturns.completeSalesReturn(sr1.id, actor, dsA.manager)).toBe('completed');
      await flush('A');
    });

    // 3. inventory restored (stock + valuation at 4.00 × 4, NOT 7.00 × 4)
    const stock = await dsA.query(`SELECT quantity FROM stock_movements WHERE "movementType"='return_in' AND "referenceId"=$1`, [sr1.id]);
    expect(stock.map((r: { quantity: number }) => Number(r.quantity))).toEqual([4]);
    const after = await valuationOf('A');
    expect(after.qty).toBe(before.qty + 4);
    expect(after.value).toBeCloseTo(before.value + 16, 4);

    // 4. COGS reversed at the original cost
    const [inv] = await eventsFor('A', 'inventory.movement.recorded', sr1.id);
    expect(inv.status).toBe('POSTED');
    expect(await lines('A', inv.journalEntryId!)).toEqual(['1120 D 16.00', '5101 C 16.00']);

    // 5/7. Revenue + tax reversed, AR credited — from the ORIGINAL invoice value (40 net, tax 14 × 40/100 = 5.60), not the declared 9.00 price
    const [cr] = await eventsFor('A', 'returns.sale_return.credited', sr1.id);
    expect(cr.status).toBe('POSTED');
    expect(await lines('A', cr.journalEntryId!)).toEqual(['1110 C 45.60', '2120 D 5.60', '4102 D 40.00']);

    // 6. customer credit: ledger credit linked to the invoice; AR reduction; no cash refund
    const entries = await dsA.query(`SELECT "entryType","direction",amount::text AS amount,"invoiceId","salesOrderId" FROM customer_ledger_entries WHERE reference = $1`, [sr1.returnNumber]);
    expect(entries).toEqual([{ entryType: 'return_credit_note', direction: 'credit', amount: '45.60', invoiceId: ids.o1.invoice, salesOrderId: ids.o1.order }]);
    expect(await ledgerBalance(ids.custInvoiced)).toBe(214 - 45.6);
    expect(await dsA.query(`SELECT count(*)::int AS n FROM treasury_transactions`)).toEqual([{ n: 0 }]); // never a cash refund

    // snapshot on the document
    const [line] = await dsA.query(`SELECT "unitCostBase"::text AS cost, "costTotalBase"::text AS ct, "creditNetBase"::text AS net, "creditTaxBase"::text AS tax, "creditInvoiceId" AS inv FROM sales_return_lines WHERE "salesReturnId" = $1`, [sr1.id]);
    expect(line).toEqual({ cost: '4.0000', ct: '16.0000', net: '40.00', tax: '5.60', inv: ids.o1.invoice });
    expect((await dsA.query(`SELECT "creditedGrossBase"::text AS g FROM sales_returns WHERE id = $1`, [sr1.id]))[0].g).toBe('45.60');
  });

  it('2. QUANTITY CAP stays enforced (shared across both return types): the remaining 6 of O1 can be returned, 7 cannot', async () => {
    await expect(newSalesReturn(ids.custInvoiced, ids.o1.line, 7)).rejects.toThrow(/only 6 remain returnable/i);
    const nSr = await count('A', 'sales_returns');
    await expect(newShipmentReturn(ids.o1.shipment, ids.o1.shipmentLine, 7)).rejects.toThrow(/only 6 remain returnable/i);
    expect(await count('A', 'sales_returns')).toBe(nSr);
  });

  it('5b. the REST of O1 (6) reverses the invoice EXACTLY (cumulative rounding): net 60, tax 8.40 → invoice fully credited, customer balance for O1 back to 0, invoice paid', async () => {
    const dsA = await dsOf('A');
    const sr2 = await newSalesReturn(ids.custInvoiced, ids.o1.line, 6, '1.00'); // declared price irrelevant to the GL
    await salesReturns.completeSalesReturn(sr2.id, actor, dsA.manager);
    await flush('A');
    const [cr] = await eventsFor('A', 'returns.sale_return.credited', sr2.id);
    expect(await lines('A', cr.journalEntryId!)).toEqual(['1110 C 68.40', '2120 D 8.40', '4102 D 60.00']);
    expect(await ledgerBalance(ids.custInvoiced)).toBe(100); // only O3's invoice (100) remains
    expect(await invoices.getStatus(ids.o1.invoice, dsA.manager)).toBe('paid');
    expect(await glBalance('A', '2120')).toBeCloseTo(0, 4); // output tax fully reversed
    const [cogs] = await eventsFor('A', 'inventory.movement.recorded', sr2.id);
    expect(await lines('A', cogs.journalEntryId!)).toEqual(['1120 D 24.00', '5101 C 24.00']);
  });

  // ---------------- Shipment Return ----------------
  it('8. SHIPMENT RETURN of a sale that was never invoiced (O2): inventory/COGS ONLY at the original exit cost — no Revenue reversal, no AR credit, no ledger entry', async () => {
    const dsA = await dsOf('A');
    const ledgerBefore = await count('A', 'customer_ledger_entries');
    const r = await newShipmentReturn(ids.o2.shipment, ids.o2.shipmentLine, 2);
    expect(await shipmentReturns.completeShipmentReturn(r.id, actor, dsA.manager)).toBe('completed');
    await flush('A');
    const [inv] = await eventsFor('A', 'inventory.movement.recorded', r.id);
    expect(inv.status).toBe('POSTED');
    expect(await lines('A', inv.journalEntryId!)).toEqual(['1120 D 8.00', '5101 C 8.00']); // 2 × 4.00
    expect(await eventsFor('A', 'returns.sale_return.credited', r.id)).toEqual([]);
    expect(await count('A', 'customer_ledger_entries')).toBe(ledgerBefore);
    expect((await dsA.query(`SELECT "creditInvoiceId" AS inv, "creditNetBase" AS net FROM shipment_return_lines WHERE "shipmentReturnId" = $1`, [r.id]))[0]).toEqual({ inv: null, net: null });
  });

  it('9. SHIPMENT RETURN of an INVOICED, already PAID sale (O3): the FULL reversal — inventory/COGS + Dr Sales Returns / Cr AR — and the balance stays in the CUSTOMER\'s favour (no cash refund)', async () => {
    const dsA = await dsOf('A');
    // the customer already paid O3's invoice in full
    await ledger.postEntry({ customerId: ids.custInvoiced, entryType: 'payment', direction: 'credit', amount: '100.00', salesOrderId: ids.o3.order, invoiceId: ids.o3.invoice, reference: 'PAY-D4', reason: 'paid', createdByUserId: actor }, dsA.manager);
    await invoices.recomputeStatus(ids.o3.invoice, actor, dsA.manager);
    expect(await invoices.getStatus(ids.o3.invoice, dsA.manager)).toBe('paid');
    expect(await ledgerBalance(ids.custInvoiced)).toBe(0);

    const r = await newShipmentReturn(ids.o3.shipment, ids.o3.shipmentLine, 2); // half of O3 (4 × 25 = 100 net, no tax)
    await shipmentReturns.completeShipmentReturn(r.id, actor, dsA.manager);
    await flush('A');
    const [inv] = await eventsFor('A', 'inventory.movement.recorded', r.id);
    expect(await lines('A', inv.journalEntryId!)).toEqual(['1120 D 8.00', '5101 C 8.00']);
    const [cr] = await eventsFor('A', 'returns.sale_return.credited', r.id);
    expect(await lines('A', cr.journalEntryId!)).toEqual(['1110 C 50.00', '4102 D 50.00']); // no tax part on this invoice → no tax line
    expect(await ledgerBalance(ids.custInvoiced)).toBe(-50); // credit balance in the customer's favour — NOT refunded
    expect(await dsA.query(`SELECT count(*)::int AS n FROM treasury_transactions`)).toEqual([{ n: 0 }]);
  });

  // ---------------- fail-closed, zero mutation ----------------
  it('10. INVALID / MISSING SOURCE → rejected with ZERO mutation: unknown return id; an order never dispatched (original cost indeterminable); an order without a restock warehouse', async () => {
    const dsA = await dsOf('A');
    await expect(salesReturns.completeSalesReturn(randomUUID(), actor, dsA.manager)).rejects.toThrow(/not found/i);

    const noCost = await newSalesReturn(ids.custNoCost, ids.o4.line, 2);
    let before = await snapshot('A');
    await expect(salesReturns.completeSalesReturn(noCost.id, actor, dsA.manager)).rejects.toThrow(/original cost .* cannot be determined/i);
    expect(await snapshot('A')).toEqual(before);
    expect(await stateOf(await sr(), 'sales_return', noCost.id)).toBe('requested');

    const noWh = await newSalesReturn(ids.custNoCost, ids.o5.line, 1);
    before = await snapshot('A');
    await expect(salesReturns.completeSalesReturn(noWh.id, actor, dsA.manager)).rejects.toThrow(/no warehouse to restock/i);
    expect(await snapshot('A')).toEqual(before);
  });

  it('11. MISSING ACCOUNTING CONFIGURATION → rejected BEFORE mutation (nothing written, document stays requested); restored → the SAME document completes and posts', async () => {
    const dsA = await dsOf('A');
    // fresh invoiced order line for this: reuse O3's remaining 2 units
    const r = await newShipmentReturn(ids.o3.shipment, ids.o3.shipmentLine, 2);
    for (const [key, re] of [
      ['accounting.sales_returns_account_code', /Sales Returns account is not configured/i],
      ['accounting.inventory_cogs_account_code', /COGS account is not configured/i],
    ] as Array<[string, RegExp]>) {
      const saved = config[key];
      config[key] = '';
      try {
        const before = await snapshot('A');
        await expect(shipmentReturns.completeShipmentReturn(r.id, actor, dsA.manager)).rejects.toThrow(re);
        expect(await snapshot('A')).toEqual(before);
        expect(await processEngine.getState(await shr(), 'shipment_return', r.id, dsA.manager)).toBe('requested');
      } finally {
        config[key] = saved;
      }
    }
    // an inactive/non-postable mapping is also rejected up front
    const savedCfg = config['accounting.sales_returns_account_code'];
    config['accounting.sales_returns_account_code'] = '9999';
    const before = await snapshot('A');
    await expect(shipmentReturns.completeShipmentReturn(r.id, actor, dsA.manager)).rejects.toThrow(/does not exist in the chart/i);
    expect(await snapshot('A')).toEqual(before);
    config['accounting.sales_returns_account_code'] = savedCfg;

    expect(await shipmentReturns.completeShipmentReturn(r.id, actor, dsA.manager)).toBe('completed');
    await flush('A');
    expect((await eventsFor('A', 'returns.sale_return.credited', r.id))[0].status).toBe('POSTED');
  });

  it('11b. EVENT-TIME fail-closed: a Sales Returns mapping removed after the movement → the credit event is REJECTED (config key named, no journal); re-driven once configured', async () => {
    const dsA = await dsOf('A');
    // O1 is fully returned; use O2 (un-invoiced) for the inventory leg and a posted-config toggle on the credit leg via O3? O3 is fully returned now,
    // so exercise the handler directly through redrive of a manufactured rejected event: publish a credited event for O3's invoice with the mapping unset.
    const saved = config['accounting.sales_returns_account_code'];
    config['accounting.sales_returns_account_code'] = '';
    const returnId = randomUUID();
    await events.publish(dsA.manager, AR_EVENT_TOPICS.salesReturnCredited, {
      idempotencyKey: `d4:evt:${returnId}`, businessDate: today, orgUnitId: null, currency: 'EGP', sourceEntityType: 'credit_note', sourceEntityId: returnId, externalDocument: null, payloadVersion: 1,
      returnKind: 'sales_return', returnId, returnNumber: 'SLR-EVT', customerId: ids.custInvoiced, invoiceId: ids.o3.invoice, invoiceNumber: 'INV-D4-3', salesOrderId: ids.o3.order,
      netAmount: '10.00', taxAmount: '0.00', grossAmount: '10.00',
    });
    const journalsBefore = await count('A', 'accounting_journal_entries');
    await flush('A');
    const [ev] = await eventsFor('A', 'returns.sale_return.credited', returnId);
    expect(ev.status).toBe('REJECTED');
    expect(ev.rejectionReason).toMatch(/accounting\.sales_returns_account_code/);
    expect(await count('A', 'accounting_journal_entries')).toBe(journalsBefore);
    config['accounting.sales_returns_account_code'] = saved;
    expect((await financialEvents.redrive(ev.id, dsA.manager)).status).toBe('POSTED');
  });

  // ---------------- reconciliation + isolation ----------------
  it('15. DEBITS = CREDITS and the reconciliations hold: every journal balances; Σ valuation = GL Inventory 1120; GL AR 1110 = Σ Customer Ledger (the manufactured 10.00 event aside)', async () => {
    await flush('A');
    const unbalanced = await (await dsOf('A')).query(
      `SELECT je.id FROM "accounting_journal_entries" je JOIN "accounting_journal_lines" jl ON jl."journalEntryId" = je.id GROUP BY je.id HAVING sum(jl."debitBase") <> sum(jl."creditBase")`,
    );
    expect(unbalanced).toEqual([]);
    // the receipts at 4.00 / 14.00 were GR-style (valuation only, GL posted by their own GRNI event in production) → compare the RETURN/dispatch deltas instead:
    // valuation moved by: dispatches -76 (19 units @4.00) and returns +40 (O1) +8 (O2) +8 +8 (O3) = +64 at the ORIGINAL cost ⇒ GL 1120 moved by the same: -76 + 64 = -12
    expect(await glBalance('A', '1120')).toBeCloseTo(-12, 4);
    const v = await valuationOf('A');
    expect(v.value).toBeCloseTo(40 * 4 + 9 * 14 - 76 + 64, 4); // = receipts (GR-style, no GL here) + the delta the GL carries
    expect(v.value - (40 * 4 + 9 * 14)).toBeCloseTo(await glBalance('A', '1120'), 4); // Σ valuation delta = GL Inventory
    // AR: invoices 114 + 100 = 214; credits 45.60 + 68.40 + 50 + 50 + the manufactured 10 ⇒ GL AR
    expect(await glBalance('A', '1110')).toBeCloseTo(214 - 45.6 - 68.4 - 50 - 50 - 10, 4);
  });

  it('12/13/14. ISOLATION: everything stayed in Company A; Company B is untouched (no stock, valuation, events, journals, ledger, outbox) and the Platform/control-plane outbox is empty', async () => {
    const dsB = await dsOf('B');
    for (const t of ['stock_movements', 'inventory_valuation_state', 'accounting_financial_events', 'accounting_journal_entries', 'customer_ledger_entries', 'sales_returns', 'shipment_returns', 'event_outbox']) {
      expect({ t, n: Number((await dsB.query(`SELECT count(*) AS n FROM "${t}"`))[0].n) }).toEqual({ t, n: 0 });
    }
    expect(Number((await h.controlPlane.query(`SELECT count(*) AS n FROM "event_outbox"`))[0].n)).toBe(0);
  });

  it('12b. a return id of Company A completed through Company B\'s manager is rejected (A→B DENY) and changes nothing', async () => {
    const dsB = await dsOf('B');
    const before = await snapshot('B');
    await expect(salesReturns.completeSalesReturn(sr1.id, actor, dsB.manager)).rejects.toThrow(/not found/i);
    expect(await snapshot('B')).toEqual(before);
  });

  // small indirections so the process definitions stay imported lazily
  async function sr() {
    return (await import('../domain/sales-return-process')).SALES_RETURN_PROCESS;
  }
  async function shr() {
    return (await import('../domain/shipment-return-process')).SHIPMENT_RETURN_PROCESS;
  }
});
