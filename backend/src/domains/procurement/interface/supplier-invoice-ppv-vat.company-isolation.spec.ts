import { randomUUID } from 'crypto';
import { SupplierInvoiceService } from '../application/supplier-invoice.service';
import { SupplierLedgerService } from '../application/supplier-ledger.service';
import { GoodsReceiptService } from '../application/goods-receipt.service';
import { GrniLedgerService } from '../application/grni-ledger.service';
import { PURCHASE_ORDER_PROCESS } from '../domain/purchase-order-process';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { InventoryValuationService } from '../../inventory-valuation/application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../../inventory-valuation/application/moving-average-cost-engine.service';
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
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { AP_EVENT_TOPICS } from '../../../foundation/module-registry/contracts/ap-events.contract';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';
import { makeProductLifecycleGate } from './product-lifecycle-gate.test-helper';

/**
 * D5 (2026-10-05, CTO-approved PPV + Input VAT policy) — real-Postgres proof, Company A with Company B as the untouched
 * witness. The full chain is real: PO → Goods Receipt (inventory + valuation + `Dr Inventory / Cr GRNI`) → Supplier Invoice
 * draft/post/void → Supplier Ledger → Company outbox → financial events → posting gate → GL. The ambient connection has only
 * `core` tables and an inert outbox.
 *
 * Policy under test: GRNI is cleared for exactly what the receipt credited (qty × PO cost); the net price difference goes to the
 * configured PPV account (Dr when the invoice is higher, Cr when lower); the explicit VAT posts to the single `tax_receivable`
 * account; AP / Supplier Ledger carry the GROSS; inventory valuation never moves because of an invoice price; void/cancel reverses
 * ledger + GL + `quantityInvoiced` atomically; every missing configuration is rejected BEFORE any mutation.
 */
describe('D5 — supplier invoice PPV + Input VAT (GRNI clearing, gross AP, atomic void) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let events: EventBusService;
  let invoices: SupplierInvoiceService;
  let goodsReceipts: GoodsReceiptService;
  let ledger: SupplierLedgerService;
  let processEngine: ProcessEngineService;
  let financialEvents: FinancialEventService;
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';

  const config: Record<string, unknown> = { 'accounting.purchase_price_variance_account_code': '5301' };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);
  const ids = { warehouse: randomUUID(), product: randomUUID(), supplierVat: randomUUID(), supplierPlain: randomUUID() };

  async function seedCompany(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'D5 Operator',$2) ON CONFLICT DO NOTHING`, [actor, `d5-${k}@test.local`]);
    for (const [code, name, type, normal, fn] of [
      ['1120', 'Inventory', 'asset', 'debit', 'inventory'],
      ['1140', 'Input VAT Receivable', 'asset', 'debit', 'tax_receivable'],
      ['2101', 'Accounts Payable', 'liability', 'credit', 'ap'],
      ['2115', 'GRNI', 'liability', 'credit', 'grni'],
      ['5301', 'Purchase Price Variance', 'expense', 'debit', null],
      ['5399', 'Misc Expense', 'expense', 'debit', null],
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

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'd5_ppv_vat', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });

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

    const inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, events, valuation as never, policyRegistry);
    goodsReceipts = new GoodsReceiptService(h.controlPlane, processEngine, numbering, audit, inventory, events, makeProductLifecycleGate(h.controlPlane));
    ledger = new SupplierLedgerService(h.controlPlane, numbering, audit);
    invoices = new SupplierInvoiceService(h.controlPlane, numbering, processEngine, audit, ledger, events, policyRegistry);

    await seedCompany('A');
    await seedCompany('B');
    const ds = await dsOf('A');
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-A','Main','active')`, [ids.warehouse]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-D5','D5 Product','10.00','active')`, [ids.product]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName","vatRegistrationNumber") VALUES ($1,'SUP-VAT','VAT Registered Supplier','VAT-100200300')`, [ids.supplierVat]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,'SUP-PLAIN','Unregistered Supplier')`, [ids.supplierPlain]);
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('D5 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---------------- helpers ----------------
  const flush = async (k: Key) => events.dispatchAfterCommit((await dsOf(k)).manager);
  const count = async (k: Key, table: string) => Number((await (await dsOf(k)).query(`SELECT count(*) AS n FROM "${table}"`))[0].n);
  const glBalance = async (k: Key, code: string) =>
    Number(
      (await (await dsOf(k)).query(
        `SELECT coalesce(sum(jl."debitBase" - jl."creditBase"), 0)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE ga.code = $1`,
        [code],
      ))[0].b,
    );
  async function lines(k: Key, journalEntryId: string): Promise<string[]> {
    const rows: Array<{ code: string; dr: string; cr: string }> = await (await dsOf(k)).query(
      `SELECT ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY ga.code`,
      [journalEntryId],
    );
    return rows.map((r) => (Number(r.dr) > 0 ? `${r.code} D ${Number(r.dr).toFixed(2)}` : `${r.code} C ${Number(r.cr).toFixed(2)}`));
  }
  async function invoiceEvent(invoiceId: string, topic: string) {
    const ds = await dsOf('A');
    const rows = await ds.query(
      `SELECT fe.status, fe."rejectionReason", fe."journalEntryId" FROM "accounting_financial_events" fe WHERE fe."eventType" = $1 AND fe.payload->>'supplierInvoiceId' = $2 ORDER BY fe."receivedAt" DESC`,
      [topic, invoiceId],
    );
    return rows as Array<{ status: string; rejectionReason: string | null; journalEntryId: string | null }>;
  }
  const valuationTotal = async () => Number((await (await dsOf('A')).query(`SELECT coalesce(sum("totalValueBase"),0)::text AS v FROM "inventory_valuation_state"`))[0].v);
  const quantityInvoiced = async (poLineId: string) => Number((await (await dsOf('A')).query(`SELECT "quantityInvoiced"::text AS q FROM purchase_order_lines WHERE id = $1`, [poLineId]))[0].q);
  const supplierBalance = async (supplierId: string) => Number(await ledger.getSupplierBalance(supplierId, (await dsOf('A')).manager));

  async function snapshot() {
    return {
      invoices: await count('A', 'supplier_invoices'),
      ledger: await count('A', 'supplier_ledger_entries'),
      outbox: await count('A', 'event_outbox'),
      journals: await count('A', 'accounting_journal_entries'),
      invoiced: (await (await dsOf('A')).query(`SELECT coalesce(sum("quantityInvoiced"),0)::text AS q FROM purchase_order_lines`))[0].q as string,
    };
  }

  /** A PO of `qty` units at the PO cost, approved, fully received through the REAL Goods Receipt service (Dr Inventory / Cr GRNI). */
  async function receivedPo(supplierId: string, qty: number, poCost = '10.00') {
    const ds = await dsOf('A');
    const m = ds.manager;
    const poId = randomUUID();
    const poLineId = randomUUID();
    await m.query(`INSERT INTO "purchase_orders" ("id","poNumber","supplierId","warehouseId","totalAmountBase") VALUES ($1,$2,$3,$4,$5)`, [poId, `PO-${poId.slice(0, 8)}`, supplierId, ids.warehouse, (qty * Number(poCost)).toFixed(2)]);
    await m.query(
      `INSERT INTO "purchase_order_lines" ("id","purchaseOrderId","productId","quantity","unitCostBase","lineTotalBase") VALUES ($1,$2,$3,$4,$5,$6)`,
      [poLineId, poId, ids.product, String(qty), poCost, (qty * Number(poCost)).toFixed(2)],
    );
    await processEngine.start(PURCHASE_ORDER_PROCESS, 'purchase_order', poId, m);
    await processEngine.transition(PURCHASE_ORDER_PROCESS, 'purchase_order', poId, 'submit', actor, m);
    await processEngine.transition(PURCHASE_ORDER_PROCESS, 'purchase_order', poId, 'approve', actor, m);
    await goodsReceipts.post({ purchaseOrderId: poId, lines: [{ purchaseOrderLineId: poLineId, quantityReceived: String(qty) }] }, actor, m);
    await flush('A');
    return { poId, poLineId };
  }

  async function draft(po: { poId: string; poLineId: string }, qty: number, cost: string, taxAmount?: string) {
    const ds = await dsOf('A');
    return invoices.createDraftInvoice(
      { purchaseOrderId: po.poId, lines: [{ purchaseOrderLineId: po.poLineId, quantity: String(qty), unitCostBase: cost }], taxAmount: taxAmount ?? null },
      actor,
      ds.manager,
    );
  }
  async function post(invoiceId: string) {
    const ds = await dsOf('A');
    const r = await invoices.postInvoice(invoiceId, actor, ds.manager);
    await flush('A');
    return r;
  }
  async function postedJournal(invoiceId: string) {
    const [e] = await invoiceEvent(invoiceId, AP_EVENT_TOPICS.supplierInvoicePosted);
    expect(e.status).toBe('POSTED');
    return lines('A', e.journalEntryId!);
  }

  // ---------------- scenarios ----------------
  it('1. SAME PRICE (GR 100 / invoice 100): Dr GRNI 100 / Cr AP 100 — no PPV line; ledger credit 100; inventory valuation untouched', async () => {
    const po = await receivedPo(ids.supplierVat, 10);
    const v0 = await valuationTotal();
    const inv = await draft(po, 10, '10.00');
    await post(inv.id);
    expect(await postedJournal(inv.id)).toEqual(['2101 C 100.00', '2115 D 100.00']);
    expect(await supplierBalance(ids.supplierVat)).toBe(100);
    expect(await valuationTotal()).toBeCloseTo(v0, 4);
    expect(inv.ppvBase).toBe('0.0000');
  });

  it('2. INVOICE HIGHER (GR 100 / invoice 110): Dr GRNI 100 + Dr PPV 10 / Cr AP 110; GRNI fully cleared; valuation stays at the receipt cost', async () => {
    const po = await receivedPo(ids.supplierVat, 10);
    const v0 = await valuationTotal();
    const inv = await draft(po, 10, '11.00');
    expect(inv.ppvBase).toBe('10.0000');
    await post(inv.id);
    expect(await postedJournal(inv.id)).toEqual(['2101 C 110.00', '2115 D 100.00', '5301 D 10.00']);
    expect(await valuationTotal()).toBeCloseTo(v0, 4);
  });

  it('3. INVOICE LOWER (GR 100 / invoice 90): Dr GRNI 100 / Cr AP 90 + Cr PPV 10 — PPV moves in the CREDIT direction and the journal balances', async () => {
    const po = await receivedPo(ids.supplierVat, 10);
    const inv = await draft(po, 10, '9.00');
    expect(inv.ppvBase).toBe('-10.0000');
    await post(inv.id);
    expect(await postedJournal(inv.id)).toEqual(['2101 C 90.00', '2115 D 100.00', '5301 C 10.00']);
  });

  it('4. VAT APPLICABLE (net 100 + VAT 14, registered supplier): Dr GRNI 100 + Dr Input VAT 14 / Cr AP 114; Supplier Ledger carries the GROSS 114', async () => {
    const po = await receivedPo(ids.supplierVat, 10);
    const before = await supplierBalance(ids.supplierVat);
    const inv = await draft(po, 10, '10.00', '14.00');
    await post(inv.id);
    expect(await postedJournal(inv.id)).toEqual(['1140 D 14.00', '2101 C 114.00', '2115 D 100.00']);
    expect(await supplierBalance(ids.supplierVat)).toBeCloseTo(before + 114, 2);
    const ds = await dsOf('A');
    expect(await invoices.getInvoiceRemaining(inv.id, ds.manager)).toBe('114.00');
    expect(await invoices.getStatus(inv.id, ds.manager)).toBe('posted');
  });

  it('4b. VAT + HIGHER price (net 110 + VAT 15.40): Dr GRNI 100 + Dr PPV 10 + Dr Input VAT 15.40 / Cr AP 125.40 — the CTO example', async () => {
    const po = await receivedPo(ids.supplierVat, 10);
    const inv = await draft(po, 10, '11.00', '15.40');
    await post(inv.id);
    expect(await postedJournal(inv.id)).toEqual(['1140 D 15.40', '2101 C 125.40', '2115 D 100.00', '5301 D 10.00']);
  });

  it('5. VAT-FREE (net only): no VAT line, no tax account needed; and a NON-ZERO VAT on an UNREGISTERED supplier is rejected BEFORE any mutation', async () => {
    const po = await receivedPo(ids.supplierPlain, 10);
    const before = await snapshot();
    await expect(draft(po, 10, '10.00', '14.00')).rejects.toThrow(/no VAT registration number/i);
    expect(await snapshot()).toEqual(before);

    const inv = await draft(po, 10, '10.00'); // taxAmount omitted → VAT-free
    await post(inv.id);
    expect(await postedJournal(inv.id)).toEqual(['2101 C 100.00', '2115 D 100.00']);
  });

  it('6. PARTIAL INVOICING (GR 10): 4 @10 then 6 @11 → #1 Dr GRNI 40 / Cr AP 40; #2 Dr GRNI 60 + Dr PPV 6 / Cr AP 66; quantityInvoiced = 10, GRNI left = 0; an 11th unit is rejected', async () => {
    const po = await receivedPo(ids.supplierVat, 10);
    const i1 = await draft(po, 4, '10.00');
    await post(i1.id);
    expect(await postedJournal(i1.id)).toEqual(['2101 C 40.00', '2115 D 40.00']);
    expect(await quantityInvoiced(po.poLineId)).toBe(4);
    const i2 = await draft(po, 6, '11.00');
    await post(i2.id);
    expect(await postedJournal(i2.id)).toEqual(['2101 C 66.00', '2115 D 60.00', '5301 D 6.00']); // PPV on the 6 invoiced units only
    expect(await quantityInvoiced(po.poLineId)).toBe(10);
    await expect(draft(po, 1, '10.00')).rejects.toThrow(/only 0 has been received but not yet invoiced/i);
  });

  it('7. VOID restores EVERYTHING atomically: ledger reversed, GL mirrored (GRNI, PPV, AP), state void, quantityInvoiced restored → the quantity can be invoiced again; CANCEL of a draft restores it too', async () => {
    const dsA = await dsOf('A');
    const po = await receivedPo(ids.supplierVat, 10);
    const bal0 = await supplierBalance(ids.supplierVat);
    const inv = await draft(po, 10, '11.00');
    await post(inv.id);
    expect(await quantityInvoiced(po.poLineId)).toBe(10);

    await invoices.voidInvoice(inv.id, 'wrong supplier price', actor, dsA.manager);
    await flush('A');
    expect(await invoices.getStatus(inv.id, dsA.manager)).toBe('void');
    expect(await quantityInvoiced(po.poLineId)).toBe(0);
    expect(await supplierBalance(ids.supplierVat)).toBeCloseTo(bal0, 2);
    const [v] = await invoiceEvent(inv.id, AP_EVENT_TOPICS.supplierInvoiceVoided);
    expect(v.status).toBe('POSTED');
    expect(await lines('A', v.journalEntryId!)).toEqual(['2101 D 110.00', '2115 C 100.00', '5301 C 10.00']);

    const again = await draft(po, 10, '10.00'); // the quantity is invoiceable again
    expect(await quantityInvoiced(po.poLineId)).toBe(10);
    await invoices.voidInvoice(again.id, 'cancel the draft', actor, dsA.manager); // draft → cancel_draft
    expect(await invoices.getStatus(again.id, dsA.manager)).toBe('void');
    expect(await quantityInvoiced(po.poLineId)).toBe(0);
  });

  it('7b. VOID is ALL-OR-NOTHING: if the quantity cannot be restored the whole void rolls back (state, ledger and outbox unchanged)', async () => {
    const dsA = await dsOf('A');
    const po = await receivedPo(ids.supplierVat, 5);
    const inv = await draft(po, 5, '10.00');
    await post(inv.id);
    await dsA.query(`UPDATE purchase_order_lines SET "quantityInvoiced" = 0 WHERE id = $1`, [po.poLineId]); // corrupt on purpose
    const before = await snapshot();
    await expect(invoices.voidInvoice(inv.id, 'should roll back', actor, dsA.manager)).rejects.toThrow(/Cannot restore the invoiced quantity/i);
    expect(await snapshot()).toEqual(before);
    expect(await invoices.getStatus(inv.id, dsA.manager)).toBe('posted');
    expect((await dsA.query(`SELECT status FROM supplier_ledger_entries WHERE "supplierInvoiceId" = $1`, [inv.id])).map((r: { status: string }) => r.status)).toEqual(['posted']);
    await dsA.query(`UPDATE purchase_order_lines SET "quantityInvoiced" = 5 WHERE id = $1`, [po.poLineId]); // repair, then void properly
    await invoices.voidInvoice(inv.id, 'cleanup', actor, dsA.manager);
    await flush('A');
    expect(await quantityInvoiced(po.poLineId)).toBe(0);
  });

  it('8. MISSING / INVALID PPV ACCOUNT (invoice has a variance) → postInvoice rejected BEFORE any mutation; no variance ⇒ no PPV account is needed; restored → the SAME invoice posts', async () => {
    const dsA = await dsOf('A');
    const po = await receivedPo(ids.supplierVat, 10);
    const inv = await draft(po, 10, '12.00');
    for (const [value, re] of [['', /PPV account is not configured/i], ['9999', /does not exist in the chart/i], ['1120', /is a control account/i]] as Array<[string, RegExp]>) {
      const saved = config['accounting.purchase_price_variance_account_code'];
      config['accounting.purchase_price_variance_account_code'] = value;
      try {
        const before = await snapshot();
        await expect(invoices.postInvoice(inv.id, actor, dsA.manager)).rejects.toThrow(re);
        expect(await snapshot()).toEqual(before);
        expect(await invoices.getStatus(inv.id, dsA.manager)).toBe('draft');
      } finally {
        config['accounting.purchase_price_variance_account_code'] = saved;
      }
    }
    // no variance ⇒ the PPV account is irrelevant
    const saved = config['accounting.purchase_price_variance_account_code'];
    config['accounting.purchase_price_variance_account_code'] = '';
    const po2 = await receivedPo(ids.supplierVat, 10);
    const same = await draft(po2, 10, '10.00');
    await post(same.id);
    expect(await postedJournal(same.id)).toEqual(['2101 C 100.00', '2115 D 100.00']);
    config['accounting.purchase_price_variance_account_code'] = saved;

    await post(inv.id);
    expect(await postedJournal(inv.id)).toEqual(['2101 C 120.00', '2115 D 100.00', '5301 D 20.00']);
  });

  it('9. MISSING / AMBIGUOUS INPUT VAT ACCOUNT (tax_receivable) → rejected BEFORE any mutation; no VAT ⇒ not needed', async () => {
    const dsA = await dsOf('A');
    const po = await receivedPo(ids.supplierVat, 10);
    const inv = await draft(po, 10, '10.00', '14.00');

    await dsA.query(`UPDATE accounting_gl_accounts SET "isActive" = false WHERE code = '1140'`); // none
    let before = await snapshot();
    await expect(invoices.postInvoice(inv.id, actor, dsA.manager)).rejects.toThrow(/no active postable account has the "tax_receivable"/i);
    expect(await snapshot()).toEqual(before);

    await dsA.query(`UPDATE accounting_gl_accounts SET "isActive" = true WHERE code = '1140'`);
    await dsA.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,'1141','Second Input VAT','asset','debit',true,false,true,'tax_receivable')`,
      [randomUUID()],
    ); // ambiguous
    before = await snapshot();
    await expect(invoices.postInvoice(inv.id, actor, dsA.manager)).rejects.toThrow(/more than one active postable "tax_receivable"/i);
    expect(await snapshot()).toEqual(before);
    expect(await invoices.getStatus(inv.id, dsA.manager)).toBe('draft');

    await dsA.query(`DELETE FROM accounting_gl_accounts WHERE code = '1141'`);
    await post(inv.id); // exactly one → posts
    expect(await postedJournal(inv.id)).toEqual(['1140 D 14.00', '2101 C 114.00', '2115 D 100.00']);
  });

  it('10. INVALID VAT-REGISTRATION CONDITION at POST time: registration removed after the draft → rejected before mutation; zero VAT is still fine', async () => {
    const dsA = await dsOf('A');
    const supplier = randomUUID();
    await dsA.query(`INSERT INTO "suppliers" ("id","code","legalName","vatRegistrationNumber") VALUES ($1,'SUP-LOSES-VAT','Loses VAT Reg','VAT-1')`, [supplier]);
    const po = await receivedPo(supplier, 10);
    const inv = await draft(po, 10, '10.00', '14.00');
    await dsA.query(`UPDATE suppliers SET "vatRegistrationNumber" = NULL WHERE id = $1`, [supplier]);
    const before = await snapshot();
    await expect(invoices.postInvoice(inv.id, actor, dsA.manager)).rejects.toThrow(/no VAT registration number/i);
    expect(await snapshot()).toEqual(before);
    // an un-postable draft is cancelled: its invoiced quantity is given back (a draft counts as invoiced in the GRNI subledger)
    await invoices.voidInvoice(inv.id, 'cannot be posted', actor, dsA.manager);
    expect(await quantityInvoiced(po.poLineId)).toBe(0);
  });

  it('11. LEGACY invoices keep their shape: a pre-D5 posted event (no receiptValueBase) posts Dr GRNI / Cr AP at the net and its VOID mirrors exactly that', async () => {
    const dsA = await dsOf('A');
    const invoiceId = randomUUID();
    const base = { businessDate: today, orgUnitId: null, currency: 'EGP', sourceEntityType: 'supplier_invoice', sourceEntityId: invoiceId, externalDocument: null, payloadVersion: 1, supplierInvoiceId: invoiceId, invoiceNumber: 'SINV-LEGACY', supplierId: ids.supplierVat, purchaseOrderId: null, netAmount: '55.00', taxAmount: '0', grossAmount: '55.00', dueDate: null };
    await events.publish(dsA.manager, AP_EVENT_TOPICS.supplierInvoicePosted, { ...base, idempotencyKey: `d5:legacy:${invoiceId}:posted` });
    await flush('A');
    await events.publish(dsA.manager, AP_EVENT_TOPICS.supplierInvoiceVoided, { ...base, idempotencyKey: `d5:legacy:${invoiceId}:voided`, voidReason: 'legacy void' });
    await flush('A');
    const [p] = await invoiceEvent(invoiceId, AP_EVENT_TOPICS.supplierInvoicePosted);
    const [v] = await invoiceEvent(invoiceId, AP_EVENT_TOPICS.supplierInvoiceVoided);
    expect(await lines('A', p.journalEntryId!)).toEqual(['2101 C 55.00', '2115 D 55.00']);
    expect(await lines('A', v.journalEntryId!)).toEqual(['2101 D 55.00', '2115 C 55.00']);
  });

  // ---------------- reconciliation + isolation ----------------
  it('12/13. DEBITS = CREDITS, GRNI reconciliation (GL = subledger at PO cost, no residue) and AP reconciliation (GL = Σ Supplier Ledger, gross)', async () => {
    await flush('A');
    const dsA = await dsOf('A');
    const unbalanced = await dsA.query(
      `SELECT je.id FROM "accounting_journal_entries" je JOIN "accounting_journal_lines" jl ON jl."journalEntryId" = je.id GROUP BY je.id HAVING sum(jl."debitBase") <> sum(jl."creditBase")`,
    );
    expect(unbalanced).toEqual([]);

    // GRNI: GL credit balance == Σ (received − invoiced) × PO cost over all POs (the legacy manufactured event above is an AP/GRNI pair of its own: net 0)
    const grniLedger = new GrniLedgerService(h.controlPlane);
    const sub = await grniLedger.getAllGrniBalances(undefined, dsA.manager);
    expect(-(await glBalance('A', '2115'))).toBeCloseTo(Number(sub.total), 4);
    expect(Number(sub.total)).toBeGreaterThan(0); // the un-invoiced POs (7b/9/10 setups) still carry exactly their receipt value

    // AP: GL credit balance == Σ supplier ledger (the manufactured legacy invoice has no ledger row: its +55/-55 nets to 0 in GL)
    const all = await ledger.getAllSupplierBalances(undefined, dsA.manager);
    expect(-(await glBalance('A', '2101'))).toBeCloseTo(Number(all.total), 2);

    // VAT and PPV tie to the stored figures of the posted, non-void invoices
    const posted = await dsA.query(
      `SELECT coalesce(sum(si."taxAmount"),0)::text AS tax, coalesce(sum(si."ppvBase"),0)::text AS ppv
         FROM supplier_invoices si JOIN process_instances pi ON pi."entityId" = si.id::text AND pi."entityType" = 'supplier_invoice'
        WHERE pi."currentState" IN ('posted','partially_paid','paid')`,
    );
    expect(await glBalance('A', '1140')).toBeCloseTo(Number(posted[0].tax), 2);
    expect(await glBalance('A', '5301')).toBeCloseTo(Number(posted[0].ppv), 2);
  });

  it('14/15. ISOLATION: a full invoice post inside A never requests B; Company B is untouched; the control-plane (Platform) outbox is empty', async () => {
    const po = await receivedPo(ids.supplierVat, 3);
    const inv = await draft(po, 3, '10.00', '4.20');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await post(inv.id);
    });
    const dsB = await dsOf('B');
    for (const t of ['supplier_invoices', 'supplier_ledger_entries', 'purchase_orders', 'stock_movements', 'inventory_valuation_state', 'accounting_financial_events', 'accounting_journal_entries', 'event_outbox']) {
      expect({ t, n: Number((await dsB.query(`SELECT count(*) AS n FROM "${t}"`))[0].n) }).toEqual({ t, n: 0 });
    }
    expect(Number((await h.controlPlane.query(`SELECT count(*) AS n FROM "event_outbox"`))[0].n)).toBe(0);
  });

  it('15b. a Company-A invoice id through Company B\'s manager cannot be posted or voided (A→B DENY) and changes nothing', async () => {
    const dsA = await dsOf('A');
    const dsB = await dsOf('B');
    const po = await receivedPo(ids.supplierVat, 2);
    const inv = await draft(po, 2, '10.00');
    await expect(invoices.postInvoice(inv.id, actor, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(invoices.voidInvoice(inv.id, 'x', actor, dsB.manager)).rejects.toThrow(/not found/i);
    expect(await invoices.getStatus(inv.id, dsA.manager)).toBe('draft');
  });
});
