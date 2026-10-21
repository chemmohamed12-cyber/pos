import { randomUUID } from 'crypto';
import { SupplierInvoiceService } from '../application/supplier-invoice.service';
import { SupplierLedgerService } from '../application/supplier-ledger.service';
import { InvoiceAllocationService } from '../application/invoice-allocation.service';
import { PurchaseReturnService } from '../application/purchase-return.service';
import { SupplierCreditNoteService } from '../application/supplier-credit-note.service';
import { SupplierPaymentService } from '../application/supplier-payment.service';
import { InvoiceCreditCapService } from '../application/invoice-credit-cap.service';
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
describe('Procurement invoicing phases D-2 / D-3 - supplier credit notes and returns of invoiced goods - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let events: EventBusService;
  let invoices: SupplierInvoiceService;
  let allocations: InvoiceAllocationService;
  let goodsReceipts: GoodsReceiptService;
  let inventory: InventoryService;
  let purchaseReturns: PurchaseReturnService;
  let creditNotes: SupplierCreditNoteService;
  let payments: SupplierPaymentService;
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
    const caps = new InvoiceCreditCapService(h.controlPlane);
    purchaseReturns = new PurchaseReturnService(h.controlPlane, processEngine, numbering, audit, events, inventory, valuation, ledger, invoices, caps, policyRegistry);
    creditNotes = new SupplierCreditNoteService(h.controlPlane, processEngine, numbering, audit, events, ledger, invoices, caps, policyRegistry);
    payments = new SupplierPaymentService(h.controlPlane, numbering, audit, treasury, ledger, invoices, events);

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

  // ---------------- phase D-2 / D-3: supplier credit notes and returns of invoiced goods ----------------
  const A = async () => (await dsOf('A')).manager;
  const state = async (invoiceId: string) => invoices.getStatus(invoiceId, await A());
  const noteState = async (id: string) => (await creditNotes.get(id, await A())).state;
  const newProduct = async () => {
    const id = randomUUID();
    await (await dsOf('A')).query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,'D2 Product','10.00','active')`, [id, `SKU-D2-${id.slice(0, 8)}`]);
    return id;
  };
  const valuationOf = async (productId: string) =>
    Number((await (await dsOf('A')).query(`SELECT coalesce(sum("totalValueBase"),0)::text AS v FROM "inventory_valuation_state" WHERE "productId" = $1`, [productId]))[0].v);
  const supplierBalance = async (supplierId: string) => Number(await ledger.getSupplierBalance(supplierId, await A()));
  const costDiffAfter = () => glBalance('5302');
  const retDiff = () => glBalance('5303');
  const remaining = async (invoiceId: string) => Number(await invoices.getInvoiceRemaining(invoiceId, await A()));
  async function dispatch(productId: string, qty: number) {
    await inventory.recordMovement(ids.warehouse, productId, -qty, 'dispatch', 'sales_order', randomUUID(), actor, await A());
    await flush('A');
  }
  /** receives `qty` of a fresh product at `poCost`, invoices all of it at `invoiceCost` (optional VAT) and posts the invoice */
  async function postedInvoiceFor(qty: number, invoiceCost: string, opts: { tax?: string; supplierId?: string; poCost?: string } = {}) {
    const product = await newProduct();
    const po = await poWithReceipts([qty], opts.supplierId ?? ids.supplier, product, opts.poCost ?? '10.00');
    const invoice = await invoices.createDraftInvoice(
      { purchaseOrderId: po.poId, lines: [{ purchaseOrderLineId: po.poLineId, quantity: String(qty), unitCostBase: invoiceCost }], taxAmount: opts.tax },
      actor,
      await A(),
    );
    await post(invoice.id);
    const [line]: Array<{ id: string }> = await (await dsOf('A')).query(`SELECT id FROM supplier_invoice_lines WHERE "supplierInvoiceId" = $1`, [invoice.id]);
    return { product, po, invoice, lineId: line.id };
  }
  async function creditApproved(invoiceId: string, lines: Array<{ lineId: string; amount: string }>) {
    const n = await creditNotes.createDraft({ supplierInvoiceId: invoiceId, reason: 'supplier price correction', lines: lines.map((l) => ({ supplierInvoiceLineId: l.lineId, amount: l.amount })) }, actor, await A());
    await creditNotes.submit(n.id, actor, await A());
    await creditNotes.approve(n.id, approver, await A());
    return n;
  }
  async function postNote(id: string) {
    const r = await creditNotes.post(id, approver, await A());
    await flush('A');
    return r;
  }
  async function approvedReturn(lines: Array<{ goodsReceiptLineId: string; quantity: string; supplierInvoiceLineId?: string }>) {
    const r = await purchaseReturns.createDraft({ reason: 'returned to supplier', lines }, actor, await A());
    await purchaseReturns.submit(r.id, actor, await A());
    await purchaseReturns.approve(r.id, approver, await A());
    return r;
  }
  async function postReturn(id: string) {
    const r = await purchaseReturns.post(id, approver, await A());
    await flush('A');
    return r;
  }

  it('CN1. price credit 20.00 on a posted invoice (net 100 + VAT 14): lifecycle with an independent approver; ONE ledger debit of 22.80 (net + proportional VAT 2.80) linked to the invoice; GL Dr AP / Cr Inventory 20 / Cr Input VAT 2.80; valuation -20; balances reconcile', async () => {
    const { product, invoice, lineId } = await postedInvoiceFor(10, '10.00', { tax: '14.00', supplierId: ids.supplierVat });
    const bal0 = await supplierBalance(ids.supplierVat);
    const ap0 = await glBalance('2101');
    const vat0 = await glBalance('1140');
    const inv0 = await glBalance('1120');
    const n = await creditNotes.createDraft({ supplierInvoiceId: invoice.id, reason: 'agreed price correction', supplierReference: 'CN-SUP-1', lines: [{ supplierInvoiceLineId: lineId, amount: '20.00' }] }, actor, await A());
    expect([n.netAmount, n.taxAmount]).toEqual(['20.00', '2.80']);
    await creditNotes.submit(n.id, actor, await A());
    await expect(creditNotes.approve(n.id, actor, await A())).rejects.toThrow(/cannot approve it/i);
    await expect(postNote(n.id)).rejects.toThrow(/not valid from state "submitted"/);
    await creditNotes.approve(n.id, approver, await A());
    const before = await snapshot();
    await postNote(n.id);
    expect(await noteState(n.id)).toBe('posted');
    const after = await snapshot();
    expect(after.ledger).toBe(before.ledger + 1);
    expect(after.stock).toBe(before.stock); // no stock movement for a price credit
    expect((await supplierBalance(ids.supplierVat)) - bal0).toBeCloseTo(-22.8, 2);
    expect(await glBalance('2101')).toBeCloseTo(ap0 + 22.8, 2); // Dr AP
    expect(await glBalance('1140')).toBeCloseTo(vat0 - 2.8, 2); // Cr Input VAT
    expect(await glBalance('1120')).toBeCloseTo(inv0 - 20, 2); // all units on hand
    expect(await valuationOf(product)).toBeCloseTo(80, 2);
    expect(await remaining(invoice.id)).toBeCloseTo(114 - 22.8, 2);
    expect(await state(invoice.id)).toBe('posted');
    expect(await reconcile()).toEqual([]);
  });

  it('CN2. price credit when 4 of 10 units were already sold: 12.00 reduces inventory, 8.00 goes to the SEPARATE cost-difference account (never PPV)', async () => {
    const { product, invoice, lineId } = await postedInvoiceFor(10, '10.00');
    await dispatch(product, 4);
    const cd0 = await costDiffAfter();
    const ppv0 = await glBalance('5301');
    const v0 = await valuationOf(product);
    const n = await creditApproved(invoice.id, [{ lineId, amount: '20.00' }]);
    await postNote(n.id);
    expect(await valuationOf(product)).toBeCloseTo(v0 - 12, 2);
    expect(await costDiffAfter()).toBeCloseTo(cd0 - 8, 2);
    expect(await glBalance('5301')).toBeCloseTo(ppv0, 2);
  });

  it('CN3. cumulative cap per invoice line: 60 then 50 refused (40 left) with NO write; drafts reserve value; two simultaneous 60s - exactly one is created', async () => {
    const { invoice, lineId } = await postedInvoiceFor(10, '10.00');
    await creditNotes.createDraft({ supplierInvoiceId: invoice.id, reason: 'first correction', lines: [{ supplierInvoiceLineId: lineId, amount: '60.00' }] }, actor, await A());
    const before = await snapshot();
    await expect(creditNotes.createDraft({ supplierInvoiceId: invoice.id, reason: 'second correction', lines: [{ supplierInvoiceLineId: lineId, amount: '50.00' }] }, actor, await A())).rejects.toThrow(/only 40\.00 remains creditable/i);
    expect(await snapshot()).toEqual(before);
    await creditNotes.createDraft({ supplierInvoiceId: invoice.id, reason: 'rest of the line', lines: [{ supplierInvoiceLineId: lineId, amount: '40.00' }] }, actor, await A());
    const other = await postedInvoiceFor(10, '10.00');
    const results = await Promise.allSettled([
      creditNotes.createDraft({ supplierInvoiceId: other.invoice.id, reason: 'racing one', lines: [{ supplierInvoiceLineId: other.lineId, amount: '60.00' }] }, actor, await A()),
      creditNotes.createDraft({ supplierInvoiceId: other.invoice.id, reason: 'racing two', lines: [{ supplierInvoiceLineId: other.lineId, amount: '60.00' }] }, actor, await A()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('CN4. credit AFTER full payment: the payment is untouched, the invoice balance becomes a credit balance (no automatic refund), supplier ledger shows it', async () => {
    const { invoice, lineId } = await postedInvoiceFor(10, '10.00', { tax: '14.00', supplierId: ids.supplierVat });
    const ds = await dsOf('A');
    const pay = await payments.recordPayment(ids.supplierVat, invoice.id, '114.00', 'cash', ids.cash, null, actor, ds.manager);
    await flush('A');
    expect(await state(invoice.id)).toBe('paid');
    const payRows0 = await count('A', 'supplier_payments');
    const n = await creditApproved(invoice.id, [{ lineId, amount: '20.00' }]);
    await postNote(n.id);
    expect(await count('A', 'supplier_payments')).toBe(payRows0);
    expect((await ds.query(`SELECT amount::text AS a FROM supplier_payments WHERE id = $1`, [pay.id]))[0].a).toBe('114.00');
    expect(await remaining(invoice.id)).toBeCloseTo(-22.8, 2);
    expect(await state(invoice.id)).toBe('paid');
    expect(await reconcile()).toEqual([]);
  });

  it('CN5. refused with NO write: a draft invoice, an invoice line of another invoice, zero / negative / duplicate lines; reject needs a reason, reopen -> draft, cancel; a cancelled note frees its reserved value', async () => {
    const posted = await postedInvoiceFor(10, '10.00');
    const otherLine = (await postedInvoiceFor(5, '10.00')).lineId;
    const product = await newProduct();
    const po = await poWithReceipts([4], ids.supplier, product);
    const draftOnly = await invoices.createDraftInvoice({ purchaseOrderId: po.poId, lines: [{ purchaseOrderLineId: po.poLineId, quantity: '4', unitCostBase: '10.00' }] }, actor, await A());
    const [draftLine]: Array<{ id: string }> = await (await dsOf('A')).query(`SELECT id FROM supplier_invoice_lines WHERE "supplierInvoiceId" = $1`, [draftOnly.id]);
    const before = await snapshot();
    const make = async (invoiceId: string, lines: Array<{ supplierInvoiceLineId: string; amount: string }>, reason = 'correction') =>
      creditNotes.createDraft({ supplierInvoiceId: invoiceId, reason, lines }, actor, await A());
    await expect(make(draftOnly.id, [{ supplierInvoiceLineId: draftLine.id, amount: '5' }])).rejects.toThrow(/needs a posted invoice/i);
    await expect(make(posted.invoice.id, [{ supplierInvoiceLineId: otherLine, amount: '5' }])).rejects.toThrow(/does not belong/i);
    await expect(make(posted.invoice.id, [{ supplierInvoiceLineId: posted.lineId, amount: '0' }])).rejects.toThrow(/positive/i);
    await expect(make(posted.invoice.id, [{ supplierInvoiceLineId: posted.lineId, amount: '-3' }])).rejects.toThrow(/positive/i);
    await expect(make(posted.invoice.id, [{ supplierInvoiceLineId: posted.lineId, amount: '1' }, { supplierInvoiceLineId: posted.lineId, amount: '2' }])).rejects.toThrow(/only once/i);
    await expect(make(posted.invoice.id, [{ supplierInvoiceLineId: posted.lineId, amount: '5' }], ' ')).rejects.toThrow(/reason is required/i);
    expect(await snapshot()).toEqual(before);

    const n = await make(posted.invoice.id, [{ supplierInvoiceLineId: posted.lineId, amount: '70.00' }]);
    await creditNotes.submit(n.id, actor, await A());
    await expect(creditNotes.reject(n.id, ' ', approver, await A())).rejects.toThrow(/reason is required/i);
    await creditNotes.reject(n.id, 'not agreed with the supplier', approver, await A());
    await creditNotes.reopen(n.id, actor, await A());
    await creditNotes.cancel(n.id, 'withdrawn', actor, await A());
    expect(await noteState(n.id)).toBe('void');
    await make(posted.invoice.id, [{ supplierInvoiceLineId: posted.lineId, amount: '100.00' }]); // the cancelled note's 70 is free again
    await invoices.voidInvoice(draftOnly.id, 'test clean-up', actor, await A()); // a draft invoice counts in the GRNI sub-ledger but not yet in the GL
  });

  it('CN6. fails closed with NO write when the finance owner has not assigned the cost-difference account; works once assigned; a posted note cannot be posted or cancelled again', async () => {
    const { invoice, lineId } = await postedInvoiceFor(10, '10.00');
    const n = await creditApproved(invoice.id, [{ lineId, amount: '10.00' }]);
    const saved = config['accounting.purchase_cost_difference_after_receipt_account_code'];
    config['accounting.purchase_cost_difference_after_receipt_account_code'] = '';
    const before = await snapshot();
    await expect(postNote(n.id)).rejects.toThrow(/cost differences after receipt account is not configured/i);
    expect(await noteState(n.id)).toBe('approved');
    expect(await snapshot()).toEqual(before);
    config['accounting.purchase_cost_difference_after_receipt_account_code'] = saved;
    await postNote(n.id);
    const mid = await snapshot();
    await expect(creditNotes.post(n.id, approver, await A())).rejects.toThrow(/not valid from state "posted"/);
    await expect(creditNotes.cancel(n.id, 'too late', actor, await A())).rejects.toThrow(/not valid from state "posted"/);
    expect(await snapshot()).toEqual(mid);
  });

  it('RT1. return of 4 INVOICED units (net 100 + VAT 14, cost = book cost): Dr AP 45.60 / Cr Inventory 40 / Cr Input VAT 5.60; one ledger debit linked to the invoice; GRNI untouched; counters; stock leaves once', async () => {
    const { product, po, invoice, lineId } = await postedInvoiceFor(10, '10.00', { tax: '14.00', supplierId: ids.supplierVat });
    const bal0 = await supplierBalance(ids.supplierVat);
    const ap0 = await glBalance('2101');
    const vat0 = await glBalance('1140');
    const grni0 = await glBalance('2115');
    const inv0 = await glBalance('1120');
    const r = await approvedReturn([{ goodsReceiptLineId: po.grLineIds[0], quantity: '4', supplierInvoiceLineId: lineId }]);
    const line = (await purchaseReturns.get(r.id, await A())).lines[0];
    expect([line.creditNetBase, line.creditTaxBase]).toEqual(['40.00', '5.60']);
    const before = await snapshot();
    await postReturn(r.id);
    const after = await snapshot();
    expect(after.stock).toBe(before.stock + 1);
    expect(after.ledger).toBe(before.ledger + 1);
    expect((await supplierBalance(ids.supplierVat)) - bal0).toBeCloseTo(-45.6, 2);
    expect(await glBalance('2101')).toBeCloseTo(ap0 + 45.6, 2);
    expect(await glBalance('1140')).toBeCloseTo(vat0 - 5.6, 2);
    expect(await glBalance('1120')).toBeCloseTo(inv0 - 40, 2);
    expect(await glBalance('2115')).toBeCloseTo(grni0, 2); // invoiced goods: GRNI was already cleared
    expect(await valuationOf(product)).toBeCloseTo(60, 2);
    expect(await remaining(invoice.id)).toBeCloseTo(114 - 45.6, 2);
    const grl = (await (await dsOf('A')).query(`SELECT "quantityReturned"::text AS r, "quantityReturnedInvoiced"::text AS ri FROM goods_receipt_lines WHERE id = $1`, [po.grLineIds[0]]))[0];
    expect([Number(grl.r), Number(grl.ri)]).toEqual([0, 4]);
    expect(await reconcile()).toEqual([]);
  });

  it('RT2. credited at the invoice price 11 vs book cost 10: stock leaves at 10, AP is debited 44, the 4.00 difference goes to the SEPARATE return-difference account (never PPV)', async () => {
    const { product, po, lineId } = await postedInvoiceFor(10, '11.00');
    const rd0 = await retDiff();
    const ppv0 = await glBalance('5301');
    const v0 = await valuationOf(product);
    const r = await approvedReturn([{ goodsReceiptLineId: po.grLineIds[0], quantity: '4', supplierInvoiceLineId: lineId }]);
    await postReturn(r.id);
    expect(await valuationOf(product)).toBeCloseTo(v0 - 40, 2);
    expect(await retDiff()).toBeCloseTo(rd0 - 4, 2); // credit
    expect(await glBalance('5301')).toBeCloseTo(ppv0, 2);
  });

  it('RT3. the cap is SHARED: a credit note of 80 leaves 20 - a return of 4 units (44) is refused, 2 units (22 at 11)... fits only up to the remaining value; and the other way round', async () => {
    const { po, invoice, lineId } = await postedInvoiceFor(10, '10.00');
    const n = await creditApproved(invoice.id, [{ lineId, amount: '80.00' }]);
    const before = await snapshot();
    await expect(purchaseReturns.createDraft({ reason: 'too much', lines: [{ goodsReceiptLineId: po.grLineIds[0], quantity: '3', supplierInvoiceLineId: lineId }] }, actor, await A())).rejects.toThrow(/can still be returned/i);
    expect(await snapshot()).toEqual(before);
    const ok = await approvedReturn([{ goodsReceiptLineId: po.grLineIds[0], quantity: '2', supplierInvoiceLineId: lineId }]); // 20 left -> exactly 2 units
    await postReturn(ok.id);
    await expect(postNote(n.id)).resolves.toBeDefined(); // the note's 80 + the return's 20 = the line's 100
    const view = await creditNotes.creditableLines(invoice.id, await A());
    expect(view[0].remaining).toBe('0.00');
    expect(await reconcile()).toEqual([]);
  });

  it('RT4. a MIXED return (one uninvoiced line, one invoiced line) posts one balanced journal with GRNI and AP legs; invoiced goods cannot be returned as uninvoiced and vice versa; posting twice does nothing', async () => {
    const a = await postedInvoiceFor(6, '10.00'); // all invoiced
    const product = await newProduct();
    const b = await poWithReceipts([5], ids.supplier, product); // received, uninvoiced
    const grni0 = await glBalance('2115');
    const ap0 = await glBalance('2101');
    const before = await snapshot();
    await expect(purchaseReturns.createDraft({ reason: 'wrong path', lines: [{ goodsReceiptLineId: a.po.grLineIds[0], quantity: '1' }] }, actor, await A())).rejects.toThrow(/invoiced goods are returned against their invoice line/i);
    await expect(purchaseReturns.createDraft({ reason: 'wrong path 2', lines: [{ goodsReceiptLineId: b.grLineIds[0], quantity: '1', supplierInvoiceLineId: a.lineId }] }, actor, await A())).rejects.toThrow(/can still be returned/i);
    expect(await snapshot()).toEqual(before);
    const r = await approvedReturn([
      { goodsReceiptLineId: a.po.grLineIds[0], quantity: '2', supplierInvoiceLineId: a.lineId },
      { goodsReceiptLineId: b.grLineIds[0], quantity: '3' },
    ]);
    const journals0 = await count('A', 'accounting_journal_entries');
    await postReturn(r.id);
    expect(await count('A', 'accounting_journal_entries')).toBe(journals0 + 1);
    expect(await glBalance('2115')).toBeCloseTo(grni0 + 30, 2); // GRNI debit only for the uninvoiced 3 units
    expect(await glBalance('2101')).toBeCloseTo(ap0 + 20, 2); // AP debit only for the invoiced 2 units
    const mid = await snapshot();
    await expect(purchaseReturns.post(r.id, approver, await A())).rejects.toThrow(/not valid from state "posted"/);
    expect(await snapshot()).toEqual(mid);
    const listed = await purchaseReturns.returnableInvoicedLines(ids.supplier, await A());
    expect(listed.some((x) => x.supplierInvoiceLineId === a.lineId && Number(x.returnable) === 4)).toBe(true);
  });

  it('RT5. company isolation: Company B has none of these documents and cannot reach the invoice lines of Company A; resolving A never requests B', async () => {
    const dsB = await dsOf('B');
    const { invoice, lineId } = await postedInvoiceFor(2, '10.00');
    await expect(creditNotes.createDraft({ supplierInvoiceId: invoice.id, reason: 'cross company', lines: [{ supplierInvoiceLineId: lineId, amount: '1' }] }, actor, dsB.manager)).rejects.toThrow(/not found/i);
    expect(await count('B', 'supplier_credit_notes')).toBe(0);
    expect(await count('B', 'purchase_returns')).toBe(0);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await creditNotes.list(await A());
      await creditNotes.creditableLines(invoice.id, await A());
      await purchaseReturns.returnableInvoicedLines(ids.supplier, await A());
    });
  });

  it('D-Z. final: GL inventory = valuation, GL AP = supplier sub-ledger, GRNI sub-ledger = GL, trial balance zero, reconciliation clean', async () => {
    const ds = await dsOf('A');
    const val = Number((await ds.query(`SELECT coalesce(sum("totalValueBase"),0)::text AS v FROM "inventory_valuation_state"`))[0].v);
    expect(await glBalance('1120')).toBeCloseTo(val, 2);
    const ledgerTotal = (await supplierBalance(ids.supplier)) + (await supplierBalance(ids.supplierVat)) + (await supplierBalance(ids.otherSupplier));
    expect(-(await glBalance('2101'))).toBeCloseTo(ledgerTotal, 2);
    const t = await new GrniLedgerService(h.controlPlane).getAllGrniBalances(undefined, await A());
    expect(Number(t.total)).toBeCloseTo(-(await glBalance('2115')), 2);
    const tb: Array<{ d: string }> = await ds.query(`SELECT coalesce(sum("debitBase" - "creditBase"),0)::text AS d FROM accounting_journal_lines`);
    expect(Number(tb[0].d)).toBeCloseTo(0, 2);
    expect(await reconcile()).toEqual([]);
  });
});
