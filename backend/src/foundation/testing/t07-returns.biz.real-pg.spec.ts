import { randomUUID } from 'crypto';
import { BizEnv, COMPANY_TAGS, abortBiz, attempt, auditChainValid, finishBiz, record, result, setUpBiz, tally, widePool } from './biz-support';
import { reconcileAndRecord } from './biz-reconcile';
import { SalesReturnsService } from '../../domains/returns/application/sales-returns.service';
import { ReturnFinancialsService } from '../../domains/returns/application/return-financials.service';
import { OrderLineReturnCapacityService } from '../../domains/returns/application/order-line-return-capacity.service';
import { SalesOrdersService } from '../../domains/sales-orders/application/sales-orders.service';
import { CustomersService } from '../../domains/crm/application/customers.service';
import { InventoryService } from '../../domains/inventory-warehouse/application/inventory.service';
import { InventoryValuationService } from '../../domains/inventory-valuation/application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../../domains/inventory-valuation/application/moving-average-cost-engine.service';
import { CustomerLedgerService } from '../../domains/customer-finance/application/customer-ledger.service';
import { InvoiceService } from '../../domains/customer-finance/application/invoices.service';
import { SalesInvoice } from '../../domains/customer-finance/infrastructure/sales-invoice.entity';
import { SalesInvoiceLine } from '../../domains/customer-finance/infrastructure/sales-invoice-line.entity';
import { SALES_INVOICE_PROCESS } from '../../domains/customer-finance/domain/sales-invoice-process';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../../domains/accounting/application/journal-entry.service';
import { FinancialEventService } from '../../domains/accounting/application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../../domains/accounting/application/financial-events/handler-registry';
import { InventoryCostingHandlerService } from '../../domains/accounting/application/financial-events/inventory-costing-handler.service';
import { InventoryPostingPolicyService } from '../../domains/accounting/application/inventory-posting-policy.service';
import { GLAccountService } from '../../domains/accounting/application/gl-account.service';
import { FiscalPeriodService } from '../../domains/accounting/application/fiscal-period.service';
import { CurrencyService } from '../../domains/accounting/application/currency.service';
import { FinancialDimensionService } from '../../domains/accounting/application/financial-dimension.service';
import { AuditService } from '../audit/audit.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { NumberingService } from '../numbering/numbering.service';
import { EventBusService } from '../events/event-bus.service';
import { ProcessEngineService } from '../process-engine/process-engine.service';
import { ConfigurationEngineService } from '../configuration-engine/configuration-engine.service';
import { InventoryPostingPolicyRegistry } from '../inventory-posting-policy/inventory-posting-policy.registry';
import { AR_EVENT_TOPICS } from '../module-registry/contracts/ar-events.contract';

/**
 * T-07 (REQ-INV-004) — FROZEN in docs/decisions/test-program/T-PLAN-FROZEN-2026-10-10.md.
 * Fixture: an order line sold/shipped/invoiced 10 @ 10.00 (net 100.00, tax 14.00); a completed prior return of 4 => 6 remain returnable.
 * Steps: two sales returns of 4 created CONCURRENTLY (separate connections), then the winner is completed.
 * Expected: exactly one is created and the other is refused ("only 2 remain returnable"); the total returned never exceeds 10 (here 8);
 * invoice credit, AR (sub-ledger = GL 1110) and stock/valuation agree with the independent oracle (cumulative-rounding rule of the original invoice).
 * 5 rounds, each on a fresh order. Any deviation is STOP. Disposable databases `daii_test_biz_t07_*` only. (The setup mirrors the D4 returns-accounting spec.)
 */
describe('T-07 — concurrent sales returns never exceed the returnable quantity', () => {
  jest.setTimeout(1_800_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('two concurrent returns of 4 against 6 remaining', async () => {
    try {
      env = await setUpBiz('T-07', 'biz_t07', { tags: [...COMPANY_TAGS, 'logistics'] });
      const e = env;
      const { h, dsA, actor } = e;
      const wide = await widePool(e, 20);
      const today = new Date().toISOString().slice(0, 10);
      const year = today.slice(0, 4);
      const config: Record<string, unknown> = { 'accounting.inventory_cogs_account_code': '5101', 'accounting.sales_returns_account_code': '4102', 'logistics.sales_return_eligibility_window_days': 365 };

      // ---- chart, calendar, numbering (as the D4 spec) ----
      for (const [code, name, type, normal, fn] of [
        ['1110', 'Accounts Receivable', 'asset', 'debit', 'ar'], ['1120', 'Inventory', 'asset', 'debit', 'inventory'], ['2120', 'Output Tax Payable', 'liability', 'credit', 'tax_payable'],
        ['3105', 'Opening Balance Equity', 'equity', 'credit', null], ['4101', 'Sales Revenue', 'revenue', 'credit', null], ['4102', 'Sales Returns', 'revenue', 'debit', null], ['5101', 'Cost of Goods Sold', 'expense', 'debit', null],
      ] as Array<[string, string, string, string, string | null]>) {
        await dsA.query(
          `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`,
          [randomUUID(), code, name, type, normal, fn],
        );
      }
      const fy = randomUUID();
      const fpId = randomUUID();
      await dsA.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
      await dsA.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fpId, fy, `${year}-01-01`, `${year}-12-31`]);
      await dsA.query(
        `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
        [randomUUID(), fy, randomUUID(), fpId],
      );
      await new NumberingService(h.controlPlane).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, dsA.manager);

      // ---- real service graph ----
      const inert = {} as never;
      const audit = new AuditService(h.controlPlane);
      const numbering = new NumberingService(h.controlPlane);
      const events = new EventBusService(inert, h.connections);
      const processEngine = new ProcessEngineService(h.controlPlane);
      const cfg = { get: (key: string) => config[key] } as unknown as ConfigurationEngineService;
      const currencies = new CurrencyService(h.controlPlane, audit);
      const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
      const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
      const dimensions = new FinancialDimensionService(h.controlPlane, audit);
      const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, cfg, dimensions);
      const valuation = new InventoryValuationService(new MovingAverageCostEngine(h.controlPlane));
      const handlerRegistry = new FinancialEventHandlerRegistry();
      const financialEvents = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, handlerRegistry, cfg);
      financialEvents.onModuleInit();
      new InventoryCostingHandlerService(handlerRegistry, valuation).onModuleInit();
      const policyRegistry = new InventoryPostingPolicyRegistry();
      new InventoryPostingPolicyService(cfg, policyRegistry).onModuleInit();
      const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
      const salesOrders = new SalesOrdersService(inert, inert, inert, inert, authorization, inert, inert, inert, inert, inert, inert);
      const customers = new CustomersService(inert, inert, inert, inert, inert, inert, inert, inert);
      const inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, events, valuation as never, policyRegistry);
      const ledger = new CustomerLedgerService(h.controlPlane, numbering, audit, customers);
      const invoices = new InvoiceService(h.controlPlane, numbering, processEngine, audit, salesOrders, customers, ledger, events, inert);
      const financials = new ReturnFinancialsService(inventory, salesOrders, ledger, invoices, events, policyRegistry);
      const salesReturns = new SalesReturnsService(h.controlPlane, processEngine, audit, numbering, cfg, inventory, salesOrders, customers, new OrderLineReturnCapacityService(), financials, events);

      const flush = () => events.dispatchAfterCommit(dsA.manager);
      const warehouse = e.warehouseId;
      const productId = randomUUID();
      const customerId = randomUUID();
      await dsA.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-T07','T07 Product','10.00','active')`, [productId]);
      await dsA.query(`INSERT INTO "customers" ("id","code","name") VALUES ($1,'CUST-T07','T07 Customer')`, [customerId]);
      await inventory.recordMovement(warehouse, productId, 200, 'receipt', 'goods_receipt', randomUUID(), actor, dsA.manager, '4.00'); // GR-style: valuation only (declared in R2)

      async function sale(tag: string) {
        const o = { order: randomUUID(), line: randomUUID(), shipment: randomUUID(), shipmentLine: randomUUID(), invoice: '' };
        await dsA.query(`INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount","warehouseId") VALUES ($1,$2,$3,$4,'100.00',$5)`, [o.order, `SO-${tag}-${o.order.slice(0, 6)}`, customerId, actor, warehouse]);
        await dsA.query(`INSERT INTO "sales_order_lines" ("id","salesOrderId","productId","quantity","unitPrice","listPrice","lineTotal") VALUES ($1,$2,$3,10,'10.00','10.00','100.00')`, [o.line, o.order, productId]);
        await dsA.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","salesOrderId") VALUES ($1,$2,$3,$4)`, [o.shipment, randomUUID(), `WB-${o.shipment.slice(0, 8)}`, o.order]);
        await dsA.query(`INSERT INTO "shipment_lines" ("id","shipmentId","salesOrderLineId","productId","quantity","unitPrice","lineTotal") VALUES ($1,$2,$3,$4,10,'10.00','100.00')`, [o.shipmentLine, o.shipment, o.line, productId]);
        await inventory.recordMovement(warehouse, productId, -10, 'dispatch', 'sales_order', o.order, actor, dsA.manager);
        await flush();
        const m = dsA.manager;
        const number = `INV-T07-${tag}-${o.order.slice(0, 6)}`;
        const inv = await m.getRepository(SalesInvoice).save(m.getRepository(SalesInvoice).create({ invoiceNumber: number, customerId, salesOrderId: o.order, shipmentId: null, subtotal: '100.00', discountAmount: '0.00', taxAmount: '14.00', taxCodeId: null, totalAmount: '100.00', dueDate: null, createdByUserId: actor, postedByUserId: actor, voidedReason: null }));
        await m.getRepository(SalesInvoiceLine).save(m.getRepository(SalesInvoiceLine).create({ salesInvoiceId: inv.id, salesOrderLineId: o.line, productId, quantity: 10, unitPrice: '10.00', discountAmount: '0.00', lineTotal: '100.00' }));
        await processEngine.start(SALES_INVOICE_PROCESS, 'sales_invoice', inv.id, m);
        await processEngine.transition(SALES_INVOICE_PROCESS, 'sales_invoice', inv.id, 'post', actor, m);
        await ledger.postEntry({ customerId, entryType: 'sales_invoice', direction: 'debit', amount: '114.00', salesOrderId: o.order, invoiceId: inv.id, reference: number, reason: 'Sales invoice posted', createdByUserId: actor }, m);
        await events.publish(m, AR_EVENT_TOPICS.invoicePosted, {
          idempotencyKey: `t07:invoice:${inv.id}:posted`, businessDate: today, orgUnitId: null, currency: 'EGP', sourceEntityType: 'invoice', sourceEntityId: inv.id, externalDocument: null, payloadVersion: 1,
          invoiceId: inv.id, invoiceNumber: number, customerId, salesOrderId: o.order, netAmount: '100.00', taxAmount: '14.00', taxAccountCode: '2120', grossAmount: '114.00', dueDate: null,
        });
        await flush();
        o.invoice = inv.id;
        return o;
      }
      const createReturn = (line: string, qty: number, m = dsA.manager) => salesReturns.createSalesReturn(customerId, null, new Date(), [{ sourceSalesOrderLineId: line, returnQuantity: qty, returnPrice: '10.00' }], 'T-07', actor, m);

      let stop = false;
      const rounds: unknown[] = [];
      let totalReturned = 0;
      for (let round = 1; round <= 5 && !stop; round += 1) {
        const o = await sale(`R${round}`);
        const prior = await createReturn(o.line, 4); // frozen fixture: a completed prior return of 4 => 6 remain
        expect(await salesReturns.completeSalesReturn(prior.id, actor, dsA.manager)).toBe('completed');
        await flush();

        const outs = await Promise.all([1, 2].map(() => attempt(async () => (await createReturn(o.line, 4, wide.manager)).id)));
        const t = tally(outs);
        const won = outs.filter((x) => x.ok).length;
        const lost = outs.filter((x) => !x.ok);
        let winnerCompleted = 'n/a';
        if (won === 1) {
          const sr = await dsA.query(`SELECT id FROM sales_returns WHERE id <> $1 AND "createdAt" > (SELECT "createdAt" FROM sales_returns WHERE id = $1) ORDER BY "createdAt" DESC LIMIT 1`, [prior.id]);
          if (sr[0]) { winnerCompleted = await salesReturns.completeSalesReturn(sr[0].id, actor, dsA.manager); await flush(); }
        }
        const returnedQty = Number((await dsA.query(`SELECT coalesce(sum(l."returnQuantity"),0)::int AS q FROM sales_return_lines l JOIN sales_returns r ON r.id = l."salesReturnId" WHERE l."sourceSalesOrderLineId" = $1 AND r.id IN (SELECT "entityId"::uuid FROM process_instances WHERE "definitionKey" LIKE '%return%' AND "currentState" = 'completed')`, [o.line]))[0].q);
        const creditGross = Number((await dsA.query(`SELECT coalesce(sum("creditedGrossBase"),0)::text AS g FROM sales_returns WHERE id IN (SELECT "salesReturnId" FROM sales_return_lines WHERE "sourceSalesOrderLineId" = $1)`, [o.line]))[0].g);
        totalReturned += returnedQty;
        const st = { round, tally: t, won, lostMessages: lost.map((l) => l.message), winnerCompleted, returnedQty, creditGross };
        rounds.push(st);
        const ok = won === 1 && lost.length === 1 && /only 2 remain returnable/i.test(lost[0].message ?? '') && returnedQty === 8 && returnedQty <= 10 && Math.abs(creditGross - 91.2) < 0.005;
        if (!ok) { stop = true; result(e, `T-07-R${round}`, 'STOP', JSON.stringify(st)); }
      }
      record(e, 'T-07-rounds.json', rounds);
      if (!stop) result(e, 'T-07', 'PASS', '5 rounds: exactly one of two concurrent returns of 4 created (the other: only 2 remain returnable); returned 8 <= 10; credit 91.20 (net 80 + tax 11.20)');

      // independent oracle for the aggregate: each round returned 8 of 10 at the ORIGINAL cost 4.00 and original invoice value
      const ledgerNet = Number(await ledger.getCustomerBalance(customerId, dsA.manager));
      const glAr = Number((await dsA.query(`SELECT coalesce(sum(jl."debitBase" - jl."creditBase"),0)::text AS b FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE ga.code = '1110'`))[0].b);
      const oracleAr = 5 * (114 - 91.2);
      record(e, 'T-07-oracle.json', { totalReturned, ledgerNet, glAr, oracleAr });
      result(e, 'T-07-oracle-AR', Math.abs(ledgerNet - oracleAr) < 0.01 && Math.abs(glAr - oracleAr) < 0.01 ? 'PASS' : 'STOP', JSON.stringify({ ledgerNet, glAr, oracleAr }));

      result(e, 'invariant-audit-chain-valid', (await auditChainValid(e)) ? 'PASS' : 'STOP');
      await reconcileAndRecord(e, { valuationWithoutGl: 200 * 4, notes: ['the 200 x 4.00 goods-receipt-style receipt is valuation-only by design (its GL is posted by the procurement flow)'] });
      await finishBiz(e);
      expect(e.results.filter((r) => r.status === 'FAIL' || r.status === 'STOP')).toEqual([]);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
