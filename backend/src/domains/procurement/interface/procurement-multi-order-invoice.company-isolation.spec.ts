import { randomUUID } from 'crypto';
import { SupplierInvoiceService } from '../application/supplier-invoice.service';
import { SupplierPaymentService } from '../application/supplier-payment.service';
import { SupplierLedgerService } from '../application/supplier-ledger.service';
import { InvoiceAllocationService } from '../application/invoice-allocation.service';
import { GoodsReceiptService } from '../application/goods-receipt.service';
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
describe('Procurement invoicing phase E - one supplier invoice over several purchase orders - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let events: EventBusService;
  let invoices: SupplierInvoiceService;
  let payments: SupplierPaymentService;
  let allocations: InvoiceAllocationService;
  let goodsReceipts: GoodsReceiptService;
  let ledger: SupplierLedgerService;
  let processEngine: ProcessEngineService;
  let treasury: TreasuryService;
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';
  const config: Record<string, unknown> = { 'accounting.purchase_price_variance_account_code': '5301' };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);
  const ids = { warehouse: randomUUID(), product: randomUUID(), supplier: randomUUID(), otherSupplier: randomUUID(), cash: '' };

  async function seedCompany(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Alloc Operator',$2) ON CONFLICT DO NOTHING`, [actor, `alloc-${k}@test.local`]);
    for (const [code, name, type, normal, fn] of [
      ['1102', 'Bank', 'asset', 'debit', null],
      ['1120', 'Inventory', 'asset', 'debit', 'inventory'],
      ['1140', 'Input VAT Receivable', 'asset', 'debit', 'tax_receivable'],
      ['2101', 'Accounts Payable', 'liability', 'credit', 'ap'],
      ['2115', 'GRNI', 'liability', 'credit', 'grni'],
      ['5301', 'Purchase Price Variance', 'expense', 'debit', null],
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
    const financialEvents = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, handlerRegistry, cfg);
    financialEvents.onModuleInit();
    new InventoryCostingHandlerService(handlerRegistry, valuation).onModuleInit();
    const policyRegistry = new InventoryPostingPolicyRegistry();
    new InventoryPostingPolicyService(cfg, policyRegistry).onModuleInit();

    const inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, events, valuation as never, policyRegistry);
    goodsReceipts = new GoodsReceiptService(h.controlPlane, processEngine, numbering, audit, inventory, events, makeProductLifecycleGate(h.controlPlane));
    ledger = new SupplierLedgerService(h.controlPlane, numbering, audit);
    allocations = new InvoiceAllocationService(h.controlPlane);
    invoices = new SupplierInvoiceService(h.controlPlane, numbering, processEngine, audit, ledger, events, policyRegistry, allocations);
    treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
    payments = new SupplierPaymentService(h.controlPlane, numbering, audit, treasury, ledger, invoices, events);

    await seedCompany('A');
    await seedCompany('B');
    const ds = await dsOf('A');
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-A','Main','active')`, [ids.warehouse]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-AL','Alloc Product','10.00','active')`, [ids.product]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,'SUP-AL','Alloc Supplier'), ($2,'SUP-OT','Other Supplier')`, [ids.supplier, ids.otherSupplier]);
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
  const allocRows = async (invoiceId: string) =>
    (await (await dsOf('A')).query(
      `SELECT r."quantity"::text AS q, r."allocationBasis" AS basis, gr."grNumber" FROM "supplier_invoice_line_receipts" r
         JOIN "supplier_invoice_lines" sil ON sil.id = r."supplierInvoiceLineId" JOIN "goods_receipt_lines" grl ON grl.id = r."goodsReceiptLineId" JOIN "goods_receipts" gr ON gr.id = grl."goodsReceiptId"
        WHERE sil."supplierInvoiceId" = $1 ORDER BY gr."createdAt", grl.id`,
      [invoiceId],
    )).map((r: { q: string; basis: string }) => `${Number(r.q)}:${r.basis}`);
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
  async function poWithReceipts(receipts: number[], supplierId = ids.supplier) {
    const ds = await dsOf('A');
    const m = ds.manager;
    const total = receipts.reduce((s, r) => s + r, 0);
    const poId = randomUUID();
    const poLineId = randomUUID();
    await m.query(`INSERT INTO "purchase_orders" ("id","poNumber","supplierId","warehouseId","totalAmountBase") VALUES ($1,$2,$3,$4,$5)`, [poId, `PO-${poId.slice(0, 8)}`, supplierId, ids.warehouse, (total * 10).toFixed(2)]);
    await m.query(`INSERT INTO "purchase_order_lines" ("id","purchaseOrderId","productId","quantity","unitCostBase","lineTotalBase") VALUES ($1,$2,$3,$4,'10.00',$5)`, [poLineId, poId, ids.product, String(total), (total * 10).toFixed(2)]);
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
  async function draft(po: { poId: string; poLineId: string }, qty: number, cost = '10.00', grLine?: string) {
    return invoices.createDraftInvoice(
      { purchaseOrderId: po.poId, lines: [{ purchaseOrderLineId: po.poLineId, quantity: String(qty), unitCostBase: cost, goodsReceiptLineId: grLine ?? null }] },
      actor,
      (await dsOf('A')).manager,
    );
  }
  async function post(invoiceId: string) {
    const r = await invoices.postInvoice(invoiceId, actor, (await dsOf('A')).manager);
    await flush('A');
    return r;
  }
  const reconcile = async () => allocations.reconcile((await dsOf('A')).manager);

  // ---------------- phase E ----------------
  const A = async () => (await dsOf('A')).manager;
  const state = async (invoiceId: string) => invoices.getStatus(invoiceId, await A());
  async function multiDraft(parts: Array<{ po: { poId: string; poLineId: string }; qty: number; cost: string }>, extra?: { purchaseOrderIds?: string[]; primary?: string }) {
    return invoices.createDraftInvoice(
      {
        purchaseOrderId: extra?.primary,
        purchaseOrderIds: extra?.purchaseOrderIds ?? parts.map((p) => p.po.poId),
        lines: parts.map((p) => ({ purchaseOrderLineId: p.po.poLineId, quantity: String(p.qty), unitCostBase: p.cost })),
      },
      actor,
      await A(),
    );
  }

  it('E1. one invoice over TWO orders of the same supplier: header keeps the first order, lines and receipt allocations follow each order, one ledger credit, one balanced journal, GRNI cleared for both', async () => {
    const po1 = await poWithReceipts([6]);
    const po2 = await poWithReceipts([4]);
    const grni0 = await glBalance('2115');
    const before = await snapshot();
    const inv = await multiDraft([{ po: po1, qty: 6, cost: '10.00' }, { po: po2, qty: 4, cost: '10.00' }]);
    expect(inv.purchaseOrderId).toBe(po1.poId);
    expect(await allocRows(inv.id)).toEqual(['6:recorded', '4:recorded']);
    expect(await quantityInvoiced(po1.poLineId)).toBe(6);
    expect(await quantityInvoiced(po2.poLineId)).toBe(4);
    await post(inv.id);
    const after = await snapshot();
    expect(after.invoices).toBe(before.invoices + 1);
    expect(after.ledger).toBe(before.ledger + 1);
    expect(after.journals).toBe(before.journals + 1);
    expect(await glBalance('2115')).toBeCloseTo(grni0 + 100, 2);
    expect(await reconcile()).toEqual([]);
  });

  it('E2. every order sees the invoice (list by purchase order) and its own invoiced quantities', async () => {
    const po1 = await poWithReceipts([5]);
    const po2 = await poWithReceipts([5]);
    const inv = await multiDraft([{ po: po1, qty: 5, cost: '10.00' }, { po: po2, qty: 2, cost: '10.00' }]);
    expect((await invoices.listForPurchaseOrder(po1.poId, await A())).map((i) => i.id)).toEqual([inv.id]);
    expect((await invoices.listForPurchaseOrder(po2.poId, await A())).map((i) => i.id)).toEqual([inv.id]);
    const v2 = await allocations.getPurchaseOrderInvoicing(po2.poId, await A());
    expect([Number(v2[0].received), Number(v2[0].invoiced), Number(v2[0].remainingToInvoice)]).toEqual([5, 2, 3]);
  });

  it('E3. different prices per order: PPV is the net of both lines and posts once (Dr GRNI 100 + Dr PPV 10 / Cr AP 110 for 5@10 order cost vs 5@11 and 5@10)', async () => {
    const po1 = await poWithReceipts([5]);
    const po2 = await poWithReceipts([5]);
    const ppv0 = await glBalance('5301');
    const inv = await multiDraft([{ po: po1, qty: 5, cost: '11.00' }, { po: po2, qty: 5, cost: '10.00' }]);
    await post(inv.id);
    expect(await glBalance('5301')).toBeCloseTo(ppv0 + 5, 2);
    expect(await reconcile()).toEqual([]);
  });

  it('E4. refused with NO write: another supplier, a line outside the listed orders, a listed order with no line, an unknown order, an order not received yet, over-invoicing on ONE order', async () => {
    const po1 = await poWithReceipts([5]);
    const otherSupplierPo = await poWithReceipts([5], ids.otherSupplier);
    const po3 = await poWithReceipts([5]);
    const before = await snapshot();
    await expect(multiDraft([{ po: po1, qty: 1, cost: '10.00' }, { po: otherSupplierPo, qty: 1, cost: '10.00' }])).rejects.toThrow(/different suppliers/i);
    await expect(multiDraft([{ po: po1, qty: 1, cost: '10.00' }, { po: po3, qty: 1, cost: '10.00' }], { purchaseOrderIds: [po1.poId] })).rejects.toThrow(/does not belong/i);
    await expect(multiDraft([{ po: po1, qty: 1, cost: '10.00' }], { purchaseOrderIds: [po1.poId, po3.poId] })).rejects.toThrow(/no line belongs to it/i);
    await expect(multiDraft([{ po: po1, qty: 1, cost: '10.00' }], { purchaseOrderIds: [po1.poId, randomUUID()] })).rejects.toThrow(/not found/i);
    // an approved order without any receipt
    const ds = await dsOf('A');
    const poId = randomUUID();
    const lineId = randomUUID();
    await ds.query(`INSERT INTO "purchase_orders" ("id","poNumber","supplierId","warehouseId","totalAmountBase") VALUES ($1,$2,$3,$4,'50.00')`, [poId, `PO-${poId.slice(0, 8)}`, ids.supplier, ids.warehouse]);
    await ds.query(`INSERT INTO "purchase_order_lines" ("id","purchaseOrderId","productId","quantity","unitCostBase","lineTotalBase") VALUES ($1,$2,$3,5,'10.00','50.00')`, [lineId, poId, ids.product]);
    await processEngine.start(PURCHASE_ORDER_PROCESS, 'purchase_order', poId, ds.manager);
    await processEngine.transition(PURCHASE_ORDER_PROCESS, 'purchase_order', poId, 'submit', actor, ds.manager);
    await processEngine.transition(PURCHASE_ORDER_PROCESS, 'purchase_order', poId, 'approve', actor, ds.manager);
    const unreceivedBefore = await snapshot();
    await expect(multiDraft([{ po: po1, qty: 1, cost: '10.00' }, { po: { poId, poLineId: lineId }, qty: 1, cost: '10.00' }])).rejects.toThrow(/Goods Receipt/i);
    // the first order is fine, the second line is over its received quantity: nothing is saved for either
    await expect(multiDraft([{ po: po1, qty: 2, cost: '10.00' }, { po: po3, qty: 9, cost: '10.00' }])).rejects.toThrow(/received but not yet invoiced/i);
    const after = await snapshot();
    expect({ ...after, journals: 0, outbox: 0 }).toEqual({ ...unreceivedBefore, journals: 0, outbox: 0 });
    expect(after.invoices).toBe(before.invoices);
    expect(after.allocs).toBe(before.allocs);
    expect(after.invoiced).toBe(before.invoiced);
  });

  it('E5. two simultaneous multi-order invoices for the same last units: exactly one wins, nothing half-written (per-order-line locks, fixed lock order)', async () => {
    const po1 = await poWithReceipts([4]);
    const po2 = await poWithReceipts([4]);
    const before = await snapshot();
    const results = await Promise.allSettled([
      multiDraft([{ po: po1, qty: 4, cost: '10.00' }, { po: po2, qty: 4, cost: '10.00' }]),
      multiDraft([{ po: po2, qty: 4, cost: '10.00' }, { po: po1, qty: 4, cost: '10.00' }]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const after = await snapshot();
    expect(after.invoices).toBe(before.invoices + 1);
    expect(after.allocs).toBe(before.allocs + 2);
    expect(await quantityInvoiced(po1.poLineId)).toBe(4);
    expect(await quantityInvoiced(po2.poLineId)).toBe(4);
    expect(await reconcile()).toEqual([]);
  });

  it('E6. void of a POSTED multi-order invoice reverses the GL once and gives back both orders\' quantities and allocations; the quantities can be invoiced again', async () => {
    const po1 = await poWithReceipts([3]);
    const po2 = await poWithReceipts([2]);
    const grni0 = await glBalance('2115');
    const inv = await multiDraft([{ po: po1, qty: 3, cost: '10.00' }, { po: po2, qty: 2, cost: '10.00' }]);
    await post(inv.id);
    expect(await glBalance('2115')).toBeCloseTo(grni0 + 50, 2);
    await invoices.voidInvoice(inv.id, 'wrong supplier bill', actor, await A());
    await flush('A');
    expect(await state(inv.id)).toBe('void');
    expect(await glBalance('2115')).toBeCloseTo(grni0, 2);
    expect(await quantityInvoiced(po1.poLineId)).toBe(0);
    expect(await quantityInvoiced(po2.poLineId)).toBe(0);
    expect(await allocRows(inv.id)).toEqual([]);
    const again = await multiDraft([{ po: po1, qty: 3, cost: '10.00' }, { po: po2, qty: 2, cost: '10.00' }]);
    expect(await allocRows(again.id)).toEqual(['3:recorded', '2:recorded']);
    expect(await reconcile()).toEqual([]);
  });

  it('E7. a multi-order invoice is paid in two payments and settled; legacy single-order invoicing is unchanged', async () => {
    const ds = await dsOf('A');
    const po1 = await poWithReceipts([5]);
    const po2 = await poWithReceipts([5]);
    const inv = await multiDraft([{ po: po1, qty: 5, cost: '10.00' }, { po: po2, qty: 5, cost: '10.00' }]);
    await post(inv.id);
    await payments.recordPaymentAllocated(ids.supplier, [{ invoiceId: inv.id, amount: '40.00' }], 'cash', ids.cash, null, actor, ds.manager);
    await payments.recordPayment(ids.supplier, inv.id, '60.00', 'cash', ids.cash, null, actor, ds.manager);
    await flush('A');
    expect(await state(inv.id)).toBe('paid');
    const legacy = await invoices.createDraftInvoice({ purchaseOrderId: (await poWithReceipts([2])).poId, lines: [] as never }, actor, ds.manager).catch((e) => e);
    expect(String(legacy.message)).toMatch(/at least one line/i);
    expect(await reconcile()).toEqual([]);
  });

  it('E8. Company isolation: A\'s order lines through B\'s connection are not found, B has no allocations, resolving A never requests B', async () => {
    const dsB = await dsOf('B');
    const po1 = await poWithReceipts([2]);
    await expect(
      invoices.createDraftInvoice({ purchaseOrderIds: [po1.poId], lines: [{ purchaseOrderLineId: po1.poLineId, quantity: '1', unitCostBase: '10.00' }] }, actor, dsB.manager),
    ).rejects.toThrow(/not found/i);
    expect(await count('B', 'supplier_invoices')).toBe(0);
    expect(await count('B', 'supplier_invoice_line_receipts')).toBe(0);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await invoices.listForPurchaseOrder(po1.poId, await A());
      await allocations.reconcile(await A());
    });
  });

  it('E-Z. final reconciliation after every scenario; GL trial balance zero', async () => {
    expect(await reconcile()).toEqual([]);
    const tb: Array<{ d: string }> = await (await dsOf('A')).query(`SELECT coalesce(sum("debitBase" - "creditBase"),0)::text AS d FROM accounting_journal_lines`);
    expect(Number(tb[0].d)).toBeCloseTo(0, 2);
  });
});
