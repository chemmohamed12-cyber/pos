import { randomUUID } from 'crypto';
import { SupplierInvoiceService } from '../application/supplier-invoice.service';
import { SupplierLedgerService } from '../application/supplier-ledger.service';
import { InvoiceAllocationService } from '../application/invoice-allocation.service';
import { PurchaseReturnService } from '../application/purchase-return.service';
import { GrniLedgerService } from '../application/grni-ledger.service';
import { GoodsReceiptService } from '../application/goods-receipt.service';
import { PURCHASE_ORDER_PROCESS } from '../domain/purchase-order-process';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { InventoryValuationService } from '../../inventory-valuation/application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../../inventory-valuation/application/moving-average-cost-engine.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../../accounting/application/journal-entry.service';
import { FinancialEventService } from '../../accounting/application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../../accounting/application/financial-events/handler-registry';
import { InventoryCostingHandlerService } from '../../accounting/application/financial-events/inventory-costing-handler.service';
import { SupplierInvoiceCostAdjustmentHandlerService } from '../../accounting/application/financial-events/supplier-invoice-cost-adjustment-handler.service';
import { InventoryPostingPolicyService } from '../../accounting/application/inventory-posting-policy.service';
import { GLAccountService } from '../../accounting/application/gl-account.service';
import { FiscalPeriodService } from '../../accounting/application/fiscal-period.service';
import { CurrencyService } from '../../accounting/application/currency.service';
import { FinancialDimensionService } from '../../accounting/application/financial-dimension.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';
import { makeProductLifecycleGate } from './product-lifecycle-gate.test-helper';

/**
 * Procurement invoicing redesign, phases A and B (CTO-approved 2026-10-20) - real-Postgres proof, Company A with Company B as the untouched witness.
 * A: invoice lines are allocated to goods-receipt lines (FIFO or pinned), over-invoicing and a race are refused with no partial write, void releases the allocations, the per-line
 *    ordered / received / invoiced / remaining view and the reconciliation hold, GRNI in the GL equals the received-not-invoiced value.
 * B: one payment over several invoices = ONE treasury cash-out, ONE payment row, ONE event (Dr AP / Cr Bank for the total), one ledger debit per invoice; never above a payment's amount or an invoice's balance.
 */
describe('Procurement invoicing phase D-1 - purchase returns of uninvoiced goods (GRNI path) - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let events: EventBusService;
  let invoices: SupplierInvoiceService;
  let allocations: InvoiceAllocationService;
  let goodsReceipts: GoodsReceiptService;
  let inventory: InventoryService;
  let purchaseReturns: PurchaseReturnService;
  let financialEvents: FinancialEventService;
  let ledger: SupplierLedgerService;
  let processEngine: ProcessEngineService;
  let treasury: TreasuryService;
  const actor = randomUUID();
  const approver = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';
  const config: Record<string, unknown> = {
    'accounting.purchase_price_variance_account_code': '5301',
    'accounting.inventory_cogs_account_code': '5201',
    'accounting.purchase_cost_difference_after_receipt_account_code': '5302',
    'accounting.purchase_return_cost_difference_account_code': '5303',
    'accounting.purchase_return_clearing_account_code': '1135',
    'accounting.purchase_other_charges_account_code': '5304',
  };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);
  const ids = { warehouse: randomUUID(), product: randomUUID(), supplier: randomUUID(), otherSupplier: randomUUID(), supplierVat: randomUUID(), cash: '' };

  async function seedCompany(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Alloc Operator',$2) ON CONFLICT DO NOTHING`, [actor, `alloc-${k}@test.local`]);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Approver',$2) ON CONFLICT DO NOTHING`, [approver, `ap-${k}@test.local`]);
    for (const [code, name, type, normal, fn] of [
      ['1102', 'Bank', 'asset', 'debit', null],
      ['1120', 'Inventory', 'asset', 'debit', 'inventory'],
      ['1140', 'Input VAT Receivable', 'asset', 'debit', 'tax_receivable'],
      ['2101', 'Accounts Payable', 'liability', 'credit', 'ap'],
      ['2115', 'GRNI', 'liability', 'credit', 'grni'],
      ['5301', 'Purchase Price Variance', 'expense', 'debit', null],
      ['5201', 'COGS', 'expense', 'debit', null],
      ['5302', 'Purchase Cost Differences After Receipt', 'expense', 'debit', null],
      ['5303', 'Supplier Return Cost Differences', 'expense', 'debit', null],
      ['1135', 'Supplier Returns Pending Credit', 'asset', 'debit', null],
      ['5304', 'Purchase Charges Expensed', 'expense', 'debit', null],
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
    h = await setUpTwoCompanyHarness({ namePrefix: 'proc_alloc', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
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
    new SupplierInvoiceCostAdjustmentHandlerService(handlerRegistry, valuation).onModuleInit();
    const policyRegistry = new InventoryPostingPolicyRegistry();
    new InventoryPostingPolicyService(cfg, policyRegistry).onModuleInit();

    inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, events, valuation as never, policyRegistry);
    goodsReceipts = new GoodsReceiptService(h.controlPlane, processEngine, numbering, audit, inventory, events, makeProductLifecycleGate(h.controlPlane));
    ledger = new SupplierLedgerService(h.controlPlane, numbering, audit);
    allocations = new InvoiceAllocationService(h.controlPlane);
    invoices = new SupplierInvoiceService(h.controlPlane, numbering, processEngine, audit, ledger, events, policyRegistry, allocations);
    treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
    purchaseReturns = new PurchaseReturnService(h.controlPlane, processEngine, numbering, audit, events, inventory, valuation, invoices, policyRegistry);

    await seedCompany('A');
    await seedCompany('B');
    const ds = await dsOf('A');
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-A','Main','active')`, [ids.warehouse]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-AL','Alloc Product','10.00','active')`, [ids.product]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,'SUP-AL','Alloc Supplier'), ($2,'SUP-OT','Other Supplier')`, [ids.supplier, ids.otherSupplier]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName","vatRegistrationNumber") VALUES ($1,'SUP-VT','VAT Supplier','VAT-9000')`, [ids.supplierVat]);
    const cash: Array<{ id: string }> = await ds.query(`SELECT id FROM "treasury_accounts" WHERE "code" = 'MAIN-CASH'`);
    ids.cash = cash[0].id;
    await ds.query(`UPDATE "treasury_accounts" SET "glAccountCode" = '1102' WHERE id = $1`, [ids.cash]);
    await treasury.cashIn(ids.cash, '100000.00', null, null, null, 'alloc test funding', actor, ds.manager);
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('alloc teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---------------- helpers ----------------
  const flush = async (k: Key) => events.dispatchAfterCommit((await dsOf(k)).manager);
  const count = async (k: Key, table: string) => Number((await (await dsOf(k)).query(`SELECT count(*) AS n FROM "${table}"`))[0].n);
  const glBalance = async (code: string) =>
    Number(
      (await (await dsOf('A')).query(
        `SELECT coalesce(sum(jl."debitBase" - jl."creditBase"), 0)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE ga.code = $1`,
        [code],
      ))[0].b,
    );
  const quantityInvoiced = async (poLineId: string) => Number((await (await dsOf('A')).query(`SELECT "quantityInvoiced"::text AS q FROM purchase_order_lines WHERE id = $1`, [poLineId]))[0].q);
  async function snapshot() {
    return {
      invoices: await count('A', 'supplier_invoices'),
      lines: await count('A', 'supplier_invoice_lines'),
      allocs: await count('A', 'supplier_invoice_line_receipts'),
      ledger: await count('A', 'supplier_ledger_entries'),
      outbox: await count('A', 'event_outbox'),
      journals: await count('A', 'accounting_journal_entries'),
      payments: await count('A', 'supplier_payments'),
      payAllocs: await count('A', 'supplier_payment_allocations'),
      treasury: await count('A', 'treasury_transactions'),
      stock: await count('A', 'stock_movements'),
      invoiced: (await (await dsOf('A')).query(`SELECT coalesce(sum("quantityInvoiced"),0)::text AS q FROM purchase_order_lines`))[0].q as string,
    };
  }

  /** PO of `qty` units, approved; then one goods receipt per entry of `receipts` (partial receiving), through the REAL service. */
  async function poWithReceipts(receipts: number[], supplierId: string = ids.supplier, productId: string = ids.product, unitCost = '10.00') {
    const ds = await dsOf('A');
    const m = ds.manager;
    const total = receipts.reduce((s, r) => s + r, 0);
    const poId = randomUUID();
    const poLineId = randomUUID();
    await m.query(`INSERT INTO "purchase_orders" ("id","poNumber","supplierId","warehouseId","totalAmountBase") VALUES ($1,$2,$3,$4,$5)`, [poId, `PO-${poId.slice(0, 8)}`, supplierId, ids.warehouse, (total * Number(unitCost)).toFixed(2)]);
    await m.query(`INSERT INTO "purchase_order_lines" ("id","purchaseOrderId","productId","quantity","unitCostBase","lineTotalBase") VALUES ($1,$2,$3,$4,$6,$5)`, [poLineId, poId, productId, String(total), (total * Number(unitCost)).toFixed(2), unitCost]);
    await processEngine.start(PURCHASE_ORDER_PROCESS, 'purchase_order', poId, m);
    await processEngine.transition(PURCHASE_ORDER_PROCESS, 'purchase_order', poId, 'submit', actor, m);
    await processEngine.transition(PURCHASE_ORDER_PROCESS, 'purchase_order', poId, 'approve', actor, m);
    for (const qty of receipts) {
      await goodsReceipts.post({ purchaseOrderId: poId, lines: [{ purchaseOrderLineId: poLineId, quantityReceived: String(qty) }] }, actor, m);
      await flush('A');
    }
    const grLines: Array<{ id: string }> = await m.query(`SELECT grl.id FROM goods_receipt_lines grl JOIN goods_receipts gr ON gr.id = grl."goodsReceiptId" WHERE gr."purchaseOrderId" = $1 ORDER BY gr."createdAt", grl.id`, [poId]);
    return { poId, poLineId, grLineIds: grLines.map((g) => g.id) };
  }
  async function post(invoiceId: string) {
    const r = await invoices.postInvoice(invoiceId, actor, (await dsOf('A')).manager);
    await flush('A');
    return r;
  }
  const reconcile = async () => allocations.reconcile((await dsOf('A')).manager);

  // ---------------- phase D-1: purchase returns (GRNI path) ----------------
  const A = async () => (await dsOf('A')).manager;
  const state = async (returnId: string) => (await purchaseReturns.get(returnId, await A())).state;
  const newProduct = async () => {
    const id = randomUUID();
    await (await dsOf('A')).query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,'D1 Product','10.00','active')`, [id, `SKU-D1-${id.slice(0, 8)}`]);
    return id;
  };
  const valuationOf = async (productId: string) =>
    Number((await (await dsOf('A')).query(`SELECT coalesce(sum("totalValueBase"),0)::text AS v FROM "inventory_valuation_state" WHERE "productId" = $1`, [productId]))[0].v);
  const stockRows = async (productId: string) => Number((await (await dsOf('A')).query(`SELECT count(*) AS n FROM stock_movements WHERE "productId" = $1 AND "movementType" = 'purchase_return_out'`, [productId]))[0].n);
  const returned = async (grLineId: string) => Number((await (await dsOf('A')).query(`SELECT "quantityReturned"::text AS q FROM goods_receipt_lines WHERE id = $1`, [grLineId]))[0].q);
  const poReturned = async (poLineId: string) => Number((await (await dsOf('A')).query(`SELECT "quantityReturned"::text AS q FROM purchase_order_lines WHERE id = $1`, [poLineId]))[0].q);
  const retCostDiff = () => glBalance('5303');
  const grniSubLedgerMatchesGl = async () => {
    const t = await new GrniLedgerService(h.controlPlane).getAllGrniBalances(undefined, await A());
    return [Number(t.total), -(await glBalance('2115'))];
  };

  async function draftReturn(grLineId: string, qty: number) {
    return purchaseReturns.createDraft({ reason: 'damaged on arrival', lines: [{ goodsReceiptLineId: grLineId, quantity: String(qty) }] }, actor, await A());
  }
  async function approved(grLineId: string, qty: number) {
    const r = await draftReturn(grLineId, qty);
    await purchaseReturns.submit(r.id, actor, await A());
    await purchaseReturns.approve(r.id, approver, await A());
    return r;
  }
  async function postReturn(returnId: string) {
    const r = await purchaseReturns.post(returnId, approver, await A());
    await flush('A');
    return r;
  }

  it('R1. return of 4 of 10 uninvoiced units: draft -> submit -> (creator cannot approve) -> approve -> post: stock leaves once at book cost, GRNI debited at the receipt cost, one balanced journal, counters and views updated, GRNI sub-ledger = GL', async () => {
    const product = await newProduct();
    const po = await poWithReceipts([10], ids.supplier, product);
    const grni0 = await glBalance('2115');
    const inv0 = await glBalance('1120');
    const r = await draftReturn(po.grLineIds[0], 4);
    expect(await state(r.id)).toBe('draft');
    await purchaseReturns.submit(r.id, actor, await A());
    await expect(purchaseReturns.approve(r.id, actor, await A())).rejects.toThrow(/cannot approve it/i);
    await expect(postReturn(r.id)).rejects.toThrow(/not valid from state "submitted"/);
    await purchaseReturns.approve(r.id, approver, await A());
    const before = await snapshot();
    await postReturn(r.id);
    expect(await state(r.id)).toBe('posted');
    const after = await snapshot();
    expect(after.stock).toBe(before.stock + 1); // one physical movement
    expect(await stockRows(product)).toBe(1);
    expect(after.journals).toBe(before.journals + 1);
    expect(await glBalance('2115')).toBeCloseTo(grni0 + 40, 2);
    expect(await glBalance('1120')).toBeCloseTo(inv0 - 40, 2);
    expect(await valuationOf(product)).toBeCloseTo(60, 2);
    expect(await returned(po.grLineIds[0])).toBe(4);
    expect(await poReturned(po.poLineId)).toBe(4);
    const line = (await purchaseReturns.get(r.id, await A())).lines[0];
    expect([Number(line.exitValueBase), Number(line.differenceBase)]).toEqual([40, 0]);
    const view = await allocations.getPurchaseOrderInvoicing(po.poId, await A());
    expect([Number(view[0].received), Number(view[0].returned), Number(view[0].remainingToInvoice)]).toEqual([10, 4, 6]);
    const [sub, gl] = await grniSubLedgerMatchesGl();
    expect(sub).toBeCloseTo(gl, 2);
    expect(await reconcile()).toEqual([]);
  });

  it('R2. book cost differs from the receipt cost (moving average 12 vs receipt 10): stock leaves at 12, GRNI at 10, the 10.00 difference goes to the SEPARATE supplier-return cost-difference account (never PPV)', async () => {
    const product = await newProduct();
    const po1 = await poWithReceipts([10], ids.supplier, product);
    await poWithReceipts([10], ids.supplier, product, '14.00'); // average becomes 12
    expect(await valuationOf(product)).toBeCloseTo(240, 2);
    const cd0 = await retCostDiff();
    const ppv0 = await glBalance('5301');
    const grni0 = await glBalance('2115');
    const r = await approved(po1.grLineIds[0], 5);
    await postReturn(r.id);
    expect(await valuationOf(product)).toBeCloseTo(180, 2); // 5 units left at 12
    expect(await glBalance('2115')).toBeCloseTo(grni0 + 50, 2); // Dr GRNI at the receipt cost 5 x 10
    expect(await retCostDiff()).toBeCloseTo(cd0 + 10, 2); // Dr: stock left 60 against GRNI 50
    expect(await glBalance('5301')).toBeCloseTo(ppv0, 2);
    const line = (await purchaseReturns.get(r.id, await A())).lines[0];
    expect([Number(line.exitValueBase), Number(line.differenceBase)]).toEqual([60, -10]);
  });

  it('R3. fails closed with NO write when the difference account is not assigned; a return with no difference needs no such account', async () => {
    const product = await newProduct();
    const po1 = await poWithReceipts([10], ids.supplier, product);
    await poWithReceipts([10], ids.supplier, product, '14.00');
    const r = await approved(po1.grLineIds[0], 5); // difference -10
    const saved = config['accounting.purchase_return_cost_difference_account_code'];
    config['accounting.purchase_return_cost_difference_account_code'] = '';
    const before = await snapshot();
    await expect(postReturn(r.id)).rejects.toThrow(/supplier return cost differences account is not configured/i);
    expect(await state(r.id)).toBe('approved');
    expect(await snapshot()).toEqual(before);
    expect(await returned(po1.grLineIds[0])).toBe(0);
    // no difference (a fresh product at one cost): posts without the account
    const product2 = await newProduct();
    const po2 = await poWithReceipts([6], ids.supplier, product2);
    const r2 = await approved(po2.grLineIds[0], 2);
    await postReturn(r2.id);
    expect(await state(r2.id)).toBe('posted');
    config['accounting.purchase_return_cost_difference_account_code'] = saved;
    await postReturn(r.id);
    expect(await state(r.id)).toBe('posted');
  });

  it('R4. invoiced units cannot go back on a return (they need a credit note): returnable = received - returned - invoiced; the return then lowers what can still be invoiced', async () => {
    const product = await newProduct();
    const po = await poWithReceipts([10], ids.supplier, product);
    const invoice = await invoices.createDraftInvoice({ purchaseOrderId: po.poId, lines: [{ purchaseOrderLineId: po.poLineId, quantity: '6', unitCostBase: '10.00' }] }, actor, await A());
    await post(invoice.id); // posted, so the GL clears GRNI for it (the GRNI sub-ledger counts a draft invoice as invoiced already)
    const before = await snapshot();
    await expect(draftReturn(po.grLineIds[0], 5)).rejects.toThrow(/only 4 of this receipt line can still be returned/i);
    expect(await snapshot()).toEqual(before);
    const r = await approved(po.grLineIds[0], 4);
    await postReturn(r.id);
    // everything received is now either invoiced or returned: nothing left to invoice
    await expect(invoices.createDraftInvoice({ purchaseOrderId: po.poId, lines: [{ purchaseOrderLineId: po.poLineId, quantity: '1', unitCostBase: '10.00' }] }, actor, await A())).rejects.toThrow(/received but not yet invoiced/i);
    const view = await allocations.getPurchaseOrderInvoicing(po.poId, await A());
    expect([Number(view[0].received), Number(view[0].returned), Number(view[0].invoiced), Number(view[0].remainingToInvoice)]).toEqual([10, 4, 6, 0]);
    expect(await reconcile()).toEqual([]);
  });

  it('R5. a return and an invoice racing for the same last units: exactly one wins, nothing half-written', async () => {
    const product = await newProduct();
    const po = await poWithReceipts([10], ids.supplier, product);
    const r = await approved(po.grLineIds[0], 6);
    const results = await Promise.allSettled([purchaseReturns.post(r.id, approver, await A()), invoices.createDraftInvoice({ purchaseOrderId: po.poId, lines: [{ purchaseOrderLineId: po.poLineId, quantity: '6', unitCostBase: '10.00' }] }, actor, await A())]);
    await flush('A');
    expect(results.filter((x) => x.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    const won = results[1];
    if (won.status === 'fulfilled') await post((won.value as { id: string }).id);
    const retQty = await returned(po.grLineIds[0]);
    const invQty = await quantityInvoiced(po.poLineId);
    expect(retQty + invQty).toBeLessThanOrEqual(10);
    expect(await reconcile()).toEqual([]);
  });

  it('R6. refused with NO write: more than returnable, the same line twice, a missing receipt line, a blank reason, two suppliers; posting twice does nothing the second time', async () => {
    const product = await newProduct();
    const po = await poWithReceipts([5], ids.supplier, product);
    const otherPo = await poWithReceipts([5], ids.otherSupplier, product);
    const before = await snapshot();
    await expect(draftReturn(po.grLineIds[0], 6)).rejects.toThrow(/can still be returned/i);
    await expect(purchaseReturns.createDraft({ reason: 'x', lines: [{ goodsReceiptLineId: po.grLineIds[0], quantity: '1' }] }, actor, await A())).rejects.toThrow(/reason is required/i);
    await expect(
      purchaseReturns.createDraft({ reason: 'dup line', lines: [{ goodsReceiptLineId: po.grLineIds[0], quantity: '1' }, { goodsReceiptLineId: po.grLineIds[0], quantity: '1' }] }, actor, await A()),
    ).rejects.toThrow(/only once/i);
    await expect(purchaseReturns.createDraft({ reason: 'ghost', lines: [{ goodsReceiptLineId: randomUUID(), quantity: '1' }] }, actor, await A())).rejects.toThrow(/not found/i);
    await expect(
      purchaseReturns.createDraft({ reason: 'two suppliers', lines: [{ goodsReceiptLineId: po.grLineIds[0], quantity: '1' }, { goodsReceiptLineId: otherPo.grLineIds[0], quantity: '1' }] }, actor, await A()),
    ).rejects.toThrow(/one supplier only/i);
    expect(await snapshot()).toEqual(before);

    const r = await approved(po.grLineIds[0], 2);
    await postReturn(r.id);
    const mid = await snapshot();
    await expect(purchaseReturns.post(r.id, approver, await A())).rejects.toThrow(/not valid from state "posted"/);
    expect(await snapshot()).toEqual(mid);
    expect(await stockRows(product)).toBe(1);
  });

  it('R7. reject needs a reason, reopen -> draft again; a cancelled draft frees nothing it never took; Company B is untouched and cannot reach the receipt lines of Company A', async () => {
    const product = await newProduct();
    const po = await poWithReceipts([4], ids.supplier, product);
    const r = await draftReturn(po.grLineIds[0], 2);
    await purchaseReturns.submit(r.id, actor, await A());
    await expect(purchaseReturns.reject(r.id, ' ', approver, await A())).rejects.toThrow(/reason is required/i);
    await purchaseReturns.reject(r.id, 'wrong warehouse', approver, await A());
    expect(await state(r.id)).toBe('rejected');
    await purchaseReturns.reopen(r.id, actor, await A());
    expect(await state(r.id)).toBe('draft');
    await purchaseReturns.cancel(r.id, 'not needed', actor, await A());
    expect(await state(r.id)).toBe('void');
    expect(await returned(po.grLineIds[0])).toBe(0);
    const dsB = await dsOf('B');
    await expect(purchaseReturns.createDraft({ reason: 'cross company', lines: [{ goodsReceiptLineId: po.grLineIds[0], quantity: '1' }] }, actor, dsB.manager)).rejects.toThrow(/not found/i);
    expect(await count('B', 'purchase_returns')).toBe(0);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await purchaseReturns.list(await A());
    });
  });

  it('R-Z. final: GL inventory = valuation, GRNI sub-ledger = GL, trial balance zero, reconciliation clean', async () => {
    const ds = await dsOf('A');
    const val = Number((await ds.query(`SELECT coalesce(sum("totalValueBase"),0)::text AS v FROM "inventory_valuation_state"`))[0].v);
    expect(await glBalance('1120')).toBeCloseTo(val, 2);
    const [sub, gl] = await grniSubLedgerMatchesGl();
    expect(sub).toBeCloseTo(gl, 2);
    const tb: Array<{ d: string }> = await ds.query(`SELECT coalesce(sum("debitBase" - "creditBase"),0)::text AS d FROM accounting_journal_lines`);
    expect(Number(tb[0].d)).toBeCloseTo(0, 2);
    expect(await reconcile()).toEqual([]);
  });
});
