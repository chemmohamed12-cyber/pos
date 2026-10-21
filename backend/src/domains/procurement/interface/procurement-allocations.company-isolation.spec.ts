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
describe('Procurement invoicing phases A/B - receipt allocations and payment allocations - real-Postgres, A/B', () => {
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

  // ---------------- Phase A ----------------
  it('A1. two receipts (6 + 4), invoices of 7 then 3: FIFO allocation 6+1 then 3, per-line view, aggregate = allocations, reconciliation consistent', async () => {
    const po = await poWithReceipts([6, 4]);
    const i1 = await draft(po, 7);
    expect(await allocRows(i1.id)).toEqual(['6:recorded', '1:recorded']);
    const i2 = await draft(po, 3);
    expect(await allocRows(i2.id)).toEqual(['3:recorded']);
    expect(await quantityInvoiced(po.poLineId)).toBe(10);
    const view = await allocations.getPurchaseOrderInvoicing(po.poId, (await dsOf('A')).manager);
    expect(view).toHaveLength(1);
    expect(Number(view[0].ordered)).toBe(10);
    expect(Number(view[0].received)).toBe(10);
    expect(Number(view[0].invoiced)).toBe(10);
    expect(Number(view[0].remainingToInvoice)).toBe(0);
    expect(view[0].receipts.map((r) => [Number(r.received), Number(r.invoiced), Number(r.free)])).toEqual([[6, 6, 0], [4, 4, 0]]);
    expect(await reconcile()).toEqual([]);
  });

  it('A2. over-invoicing is refused and leaves NO partial write (no invoice, line, allocation, ledger, event, journal or stock movement)', async () => {
    const po = await poWithReceipts([5]);
    await draft(po, 4);
    const before = await snapshot();
    await expect(draft(po, 2)).rejects.toThrow(/received but not yet invoiced/i);
    expect(await snapshot()).toEqual(before);
    expect(await reconcile()).toEqual([]);
  });

  it('A3. two simultaneous invoices for the last 5 units: exactly one wins (per-order-line lock), the other is refused, nothing half-written', async () => {
    const po = await poWithReceipts([5]);
    const before = await snapshot();
    const results = await Promise.allSettled([draft(po, 5), draft(po, 5)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const after = await snapshot();
    expect(after.invoices).toBe(before.invoices + 1);
    expect(after.allocs).toBe(before.allocs + 1);
    expect(await quantityInvoiced(po.poLineId)).toBe(5);
    expect(await reconcile()).toEqual([]);
  });

  it('A4. a named receipt line is billed first; a receipt line of another order is refused', async () => {
    const po = await poWithReceipts([6, 4]);
    const other = await poWithReceipts([3]);
    const inv = await draft(po, 3, '10.00', po.grLineIds[1]);
    expect(await allocRows(inv.id)).toEqual(['3:recorded']);
    const view = await allocations.getPurchaseOrderInvoicing(po.poId, (await dsOf('A')).manager);
    expect(view[0].receipts.map((r) => Number(r.invoiced))).toEqual([0, 3]);
    const before = await snapshot();
    await expect(draft(po, 1, '10.00', other.grLineIds[0])).rejects.toThrow(/does not belong/i);
    expect(await snapshot()).toEqual(before);
  });

  it('A5. void of a draft and of a POSTED invoice releases the allocations and quantities, reverses the GL once, and the quantity can be invoiced again', async () => {
    const po = await poWithReceipts([8]);
    const grni0 = await glBalance('2115');
    const d = await draft(po, 3);
    await invoices.voidInvoice(d.id, 'cancel draft', actor, (await dsOf('A')).manager);
    expect(await allocRows(d.id)).toEqual([]);
    expect(await quantityInvoiced(po.poLineId)).toBe(0);

    const p = await draft(po, 8);
    await post(p.id);
    expect(await glBalance('2115')).toBeCloseTo(grni0 + 80, 2); // posting clears the 80 the receipt credited
    await invoices.voidInvoice(p.id, 'wrong invoice', actor, (await dsOf('A')).manager);
    await flush('A');
    expect(await glBalance('2115')).toBeCloseTo(grni0, 2); // the void put the 80 back
    expect(await allocRows(p.id)).toEqual([]);
    expect(await quantityInvoiced(po.poLineId)).toBe(0);
    const again = await draft(po, 8);
    expect(await allocRows(again.id)).toEqual(['8:recorded']);
    expect(await reconcile()).toEqual([]);
  });

  it('A6. GL = subledger: after receiving 10 and posting an invoice for 4, the GRNI balance moved by exactly the 6 received-not-invoiced units (60.00)', async () => {
    const base = await glBalance('2115');
    const po = await poWithReceipts([10]);
    expect(await glBalance('2115')).toBeCloseTo(base - 100, 2); // receipt credited GRNI 100
    const i1 = await draft(po, 4);
    await post(i1.id);
    expect(await glBalance('2115')).toBeCloseTo(base - 60, 2); // invoice cleared 40 -> 60 still received-not-invoiced
    const view = await allocations.getPurchaseOrderInvoicing(po.poId, (await dsOf('A')).manager);
    expect(Number(view[0].remainingToInvoice) * 10).toBeCloseTo(60, 2);
  });

  // ---------------- Phase B ----------------
  async function postedInvoice(qty: number) {
    const po = await poWithReceipts([qty]);
    const inv = await draft(po, qty);
    await post(inv.id);
    return inv;
  }

  it('B1. ONE payment over two invoices: one treasury cash-out, one payment row, one event, two ledger debits, allocations sum to the payment, statuses and GL right', async () => {
    const ds = await dsOf('A');
    const i1 = await postedInvoice(10); // 100
    const i2 = await postedInvoice(20); // 200
    const before = await snapshot();
    const bank0 = await glBalance('1102');
    const ap0 = await glBalance('2101');
    const pay = await payments.recordPaymentAllocated(
      ids.supplier,
      [{ invoiceId: i1.id, amount: '100.00' }, { invoiceId: i2.id, amount: '50.00' }],
      'bank_transfer',
      ids.cash,
      'multi',
      actor,
      ds.manager,
    );
    await flush('A');
    const after = await snapshot();
    expect(Number(pay.amount)).toBe(150);
    expect(after.payments).toBe(before.payments + 1);
    expect(after.treasury).toBe(before.treasury + 1);
    expect(after.payAllocs).toBe(before.payAllocs + 2);
    expect(after.ledger).toBe(before.ledger + 2);
    expect(after.stock).toBe(before.stock); // no stock movement
    expect(pay.supplierInvoiceId).toBe(i1.id);
    const ev: Array<{ n: string }> = await ds.query(`SELECT count(*) AS n FROM "accounting_financial_events" WHERE payload->>'supplierPaymentId' = $1`, [pay.id]);
    expect(Number(ev[0].n)).toBe(1);
    expect(await glBalance('1102')).toBeCloseTo(bank0 - 150, 2);
    expect(await glBalance('2101')).toBeCloseTo(ap0 + 150, 2);
    expect(await invoices.getStatus(i1.id, ds.manager)).toBe('paid');
    expect(await invoices.getStatus(i2.id, ds.manager)).toBe('partially_paid');
    expect(await invoices.getInvoiceRemaining(i2.id, ds.manager)).toBe('150.00');
    expect(await reconcile()).toEqual([]);
    const list = await payments.listAll(ds.manager);
    expect(list.find((p) => p.id === pay.id)!.allocations).toHaveLength(2);
  });

  it('B2. refused with NO write: above an invoice balance, the same invoice twice, another supplier\'s invoice, a draft invoice, zero amount', async () => {
    const ds = await dsOf('A');
    const i1 = await postedInvoice(5); // 50
    const po = await poWithReceipts([5], ids.otherSupplier);
    const foreign = await draft(po, 5);
    await post(foreign.id);
    const draftOnly = await draft(await poWithReceipts([2]), 2);
    const before = await snapshot();
    const go = (allocs: Array<{ invoiceId: string; amount: string }>) => payments.recordPaymentAllocated(ids.supplier, allocs, 'cash', ids.cash, null, actor, ds.manager);
    await expect(go([{ invoiceId: i1.id, amount: '50.01' }])).rejects.toThrow(/only 50\.00 remains/i);
    await expect(go([{ invoiceId: i1.id, amount: '10.00' }, { invoiceId: i1.id, amount: '10.00' }])).rejects.toThrow(/only once/i);
    await expect(go([{ invoiceId: foreign.id, amount: '10.00' }])).rejects.toThrow(/different supplier/i);
    await expect(go([{ invoiceId: draftOnly.id, amount: '10.00' }])).rejects.toThrow(/only a posted or partially paid/i);
    await expect(go([{ invoiceId: i1.id, amount: '0' }])).rejects.toThrow(/positive/i);
    // second invoice fails after the first was valid: the whole payment still leaves nothing behind
    await expect(go([{ invoiceId: i1.id, amount: '10.00' }, { invoiceId: foreign.id, amount: '10.00' }])).rejects.toThrow(/different supplier/i);
    expect(await snapshot()).toEqual(before);
  });

  it('B3. legacy compatibility: recordPayment (one invoice) still works, writes its single allocation row, and two payments on one invoice reconcile', async () => {
    const ds = await dsOf('A');
    const inv = await postedInvoice(10); // 100
    const p1 = await payments.recordPayment(ids.supplier, inv.id, '30.00', 'cash', ids.cash, null, actor, ds.manager);
    const p2 = await payments.recordPayment(ids.supplier, inv.id, '70.00', 'cash', ids.cash, null, actor, ds.manager);
    await flush('A');
    expect(p1.supplierInvoiceId).toBe(inv.id);
    expect(p2.supplierInvoiceId).toBe(inv.id);
    expect(await invoices.getStatus(inv.id, ds.manager)).toBe('paid');
    await expect(payments.recordPayment(ids.supplier, inv.id, '1.00', 'cash', ids.cash, null, actor, ds.manager)).rejects.toThrow(/only 0\.00 remains/i);
    const rows: Array<{ n: string }> = await ds.query(`SELECT count(*) AS n FROM supplier_payment_allocations WHERE "supplierInvoiceId" = $1`, [inv.id]);
    expect(Number(rows[0].n)).toBe(2);
    expect(await reconcile()).toEqual([]);
  });

  it('B4. concurrent payments for the same invoice: the balance is honoured (only one of two 60.00 payments on a 100.00 invoice succeeds)', async () => {
    const ds = await dsOf('A');
    const inv = await postedInvoice(10); // 100
    const before = await snapshot();
    const results = await Promise.allSettled([
      payments.recordPaymentAllocated(ids.supplier, [{ invoiceId: inv.id, amount: '60.00' }], 'cash', ids.cash, null, actor, ds.manager),
      payments.recordPaymentAllocated(ids.supplier, [{ invoiceId: inv.id, amount: '60.00' }], 'cash', ids.cash, null, actor, ds.manager),
    ]);
    await flush('A');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const after = await snapshot();
    expect(after.payments).toBe(before.payments + 1);
    expect(after.treasury).toBe(before.treasury + 1);
    expect(await reconcile()).toEqual([]);
  });

  // ---------------- isolation ----------------
  it('I1. Company B holds none of A\'s allocations; A\'s invoice cannot be paid through B\'s connection; resolving A never requests B\'s DataSource', async () => {
    const dsA = await dsOf('A');
    const dsB = await dsOf('B');
    expect(await count('B', 'supplier_invoice_line_receipts')).toBe(0);
    expect(await count('B', 'supplier_payment_allocations')).toBe(0);
    const inv = await postedInvoice(2);
    await expect(payments.recordPaymentAllocated(ids.supplier, [{ invoiceId: inv.id, amount: '1.00' }], 'cash', ids.cash, null, actor, dsB.manager)).rejects.toThrow(/not found/i);
    expect(await allocations.reconcile(dsB.manager)).toEqual([]);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await allocations.reconcile(dsA.manager);
      await payments.listAll(dsA.manager);
    });
  });

  it('Z. final whole-Company reconciliation after every scenario: receipts, aggregates, payments, ledger all consistent; trial balance of the GL is zero', async () => {
    expect(await reconcile()).toEqual([]);
    const tb: Array<{ d: string }> = await (await dsOf('A')).query(`SELECT coalesce(sum("debitBase" - "creditBase"),0)::text AS d FROM accounting_journal_lines`);
    expect(Number(tb[0].d)).toBeCloseTo(0, 2);
  });
});
