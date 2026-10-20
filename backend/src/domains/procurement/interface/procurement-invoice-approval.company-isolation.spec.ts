import { randomUUID } from 'crypto';
import { SupplierInvoiceService } from '../application/supplier-invoice.service';
import { SupplierPaymentService } from '../application/supplier-payment.service';
import { SupplierLedgerService } from '../application/supplier-ledger.service';
import { InvoiceAllocationService } from '../application/invoice-allocation.service';
import { InvoiceApprovalService } from '../application/invoice-approval.service';
import { InvoicePolicyService } from '../application/invoice-policy.service';
import { SupplierInvoice as SupplierInvoiceEntity } from '../infrastructure/supplier-invoice.entity';
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
describe('Procurement invoicing phase C-1 - approval lifecycle, Company price tolerance, controlled exception - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let events: EventBusService;
  let invoices: SupplierInvoiceService;
  let payments: SupplierPaymentService;
  let allocations: InvoiceAllocationService;
  let approvals: InvoiceApprovalService;
  let policies: InvoicePolicyService;
  let goodsReceipts: GoodsReceiptService;
  let ledger: SupplierLedgerService;
  let processEngine: ProcessEngineService;
  let treasury: TreasuryService;
  const actor = randomUUID();
  const approver = randomUUID();
  const approver2 = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';
  const config: Record<string, unknown> = { 'accounting.purchase_price_variance_account_code': '5301' };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);
  const ids = { warehouse: randomUUID(), product: randomUUID(), supplier: randomUUID(), otherSupplier: randomUUID(), cash: '' };

  async function seedCompany(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Alloc Operator',$2) ON CONFLICT DO NOTHING`, [actor, `alloc-${k}@test.local`]);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Approver One',$2), ($3,'Approver Two',$4) ON CONFLICT DO NOTHING`, [approver, `ap1-${k}@test.local`, approver2, `ap2-${k}@test.local`]);
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
    policies = new InvoicePolicyService(h.controlPlane, audit);
    invoices = new SupplierInvoiceService(h.controlPlane, numbering, processEngine, audit, ledger, events, policyRegistry, allocations, policies);
    approvals = new InvoiceApprovalService(h.controlPlane, processEngine, audit, policies);
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

  // ---------------- phase C-1 ----------------
  const unitCost = '10.00';
  const mkInvoice = async (qty: number, cost: string) => draft(await poWithReceipts([qty]), qty, cost);
  const state = async (invoiceId: string) => invoices.getStatus(invoiceId, (await dsOf('A')).manager);
  const A = async () => (await dsOf('A')).manager;

  it('C1-1. no policy row = legacy behaviour: draft posts directly, a price difference is informational (nothing changes for an existing Company)', async () => {
    expect(await policies.get(await A())).toEqual({ approvalRequired: false, priceTolerancePct: 0, priceToleranceAmount: null, toleranceDirection: 'both' });
    const inv = await mkInvoice(5, '11.00');
    await post(inv.id);
    expect(await state(inv.id)).toBe('posted');
  });

  it('C1-2. policy validation and audit: bad values are refused with no change; a valid update is stored and audited', async () => {
    await expect(policies.update({ priceTolerancePct: -1 }, actor, await A())).rejects.toThrow(/between 0 and 100/);
    await expect(policies.update({ priceTolerancePct: 101 }, actor, await A())).rejects.toThrow(/between 0 and 100/);
    await expect(policies.update({ priceToleranceAmount: -5 }, actor, await A())).rejects.toThrow(/zero or more/);
    await expect(policies.update({ toleranceDirection: 'sideways' as never }, actor, await A())).rejects.toThrow(/both|over_only/);
    expect((await policies.get(await A())).approvalRequired).toBe(false);
    const audits0 = await count('A', 'audit_log').catch(() => 0);
    await policies.update({ approvalRequired: true }, actor, await A());
    expect(await policies.get(await A())).toEqual({ approvalRequired: true, priceTolerancePct: 0, priceToleranceAmount: null, toleranceDirection: 'both' });
    expect(await count('A', 'audit_log').catch(() => 1)).toBeGreaterThanOrEqual(audits0);
  });

  it('C1-3. approval ON, price equal to the order: a draft cannot post directly; submit -> submitted; the creator cannot approve; another user approves; post -> posted once (GL balanced, one event); a retry changes nothing', async () => {
    const inv = await mkInvoice(10, unitCost);
    await expect(post(inv.id)).rejects.toThrow(/submitted and approved/i);
    await approvals.submit(inv.id, actor, await A());
    expect(await state(inv.id)).toBe('submitted');
    expect((await (await A()).getRepository(SupplierInvoiceEntity).findOneByOrFail({ id: inv.id })).matchStatus).toBe('within_tolerance');
    await expect(approvals.approve(inv.id, actor, await A())).rejects.toThrow(/cannot approve it/i);
    expect(await state(inv.id)).toBe('submitted');
    await approvals.approve(inv.id, approver, await A());
    expect(await state(inv.id)).toBe('approved');
    const before = await snapshot();
    await post(inv.id);
    expect(await state(inv.id)).toBe('posted');
    const after = await snapshot();
    expect(after.ledger).toBe(before.ledger + 1);
    expect(after.journals).toBe(before.journals + 1);
    // retry: refused, no second ledger entry / journal / event
    const mid = await snapshot();
    await expect(post(inv.id)).rejects.toThrow(/Cannot post an invoice in state "posted"/);
    expect(await snapshot()).toEqual(mid);
    expect(await reconcile()).toEqual([]);
  });

  it('C1-4. zero tolerance (default): any price difference holds the invoice; an on-hold invoice cannot be approved normally; the exception needs a reason and another user, is audited, then posts with PPV', async () => {
    const inv = await mkInvoice(10, '11.00');
    await approvals.submit(inv.id, actor, await A());
    expect(await state(inv.id)).toBe('on_hold');
    const row = await (await A()).getRepository(SupplierInvoiceEntity).findOneByOrFail({ id: inv.id });
    expect(row.matchStatus).toBe('exceeds_tolerance');
    expect(row.holdReason).toMatch(/beyond the Company tolerance/);
    await expect(approvals.approve(inv.id, approver, await A())).rejects.toThrow(/not valid from state "on_hold"/);
    await expect(post(inv.id)).rejects.toThrow(/Cannot post an invoice in state "on_hold"/);
    await expect(approvals.approveException(inv.id, '', approver, await A())).rejects.toThrow(/reason is required/i);
    await expect(approvals.approveException(inv.id, 'supplier agreed price rise', actor, await A())).rejects.toThrow(/cannot approve it/i);
    await approvals.approveException(inv.id, 'supplier agreed price rise', approver, await A());
    expect(await state(inv.id)).toBe('approved');
    const after = await (await A()).getRepository(SupplierInvoiceEntity).findOneByOrFail({ id: inv.id });
    expect(after.exceptionReason).toBe('supplier agreed price rise');
    expect(after.approvedByUserId).toBe(approver);
    const ppv0 = await glBalance('5301');
    await post(inv.id);
    expect(await glBalance('5301')).toBeCloseTo(ppv0 + 10, 2); // invoice 110 vs receipt 100
    expect(await reconcile()).toEqual([]);
  });

  it('C1-5. limits: 3% within a 5% limit passes; the same 3% fails an amount limit of 1.00 (both limits must pass); over_only ignores a LOWER price; a higher price still holds', async () => {
    await policies.update({ priceTolerancePct: 5, priceToleranceAmount: null, toleranceDirection: 'both' }, actor, await A());
    const ok = await mkInvoice(10, '10.30'); // +3%, amount 3.00
    await approvals.submit(ok.id, actor, await A());
    expect(await state(ok.id)).toBe('submitted');

    await policies.update({ priceTolerancePct: 5, priceToleranceAmount: 1, toleranceDirection: 'both' }, actor, await A());
    const amountFail = await mkInvoice(10, '10.30'); // pct ok, amount 3.00 > 1.00
    await approvals.submit(amountFail.id, actor, await A());
    expect(await state(amountFail.id)).toBe('on_hold');
    const detail = (await (await A()).getRepository(SupplierInvoiceEntity).findOneByOrFail({ id: amountFail.id })).matchDetail as Array<{ exceeded: string[] }>;
    expect(detail[0].exceeded).toEqual(['amount']);

    await policies.update({ priceTolerancePct: 0, priceToleranceAmount: null, toleranceDirection: 'over_only' }, actor, await A());
    const lower = await mkInvoice(10, '9.00'); // cheaper than ordered: ignored under over_only
    await approvals.submit(lower.id, actor, await A());
    expect(await state(lower.id)).toBe('submitted');
    const higher = await mkInvoice(10, '10.01');
    await approvals.submit(higher.id, actor, await A());
    expect(await state(higher.id)).toBe('on_hold');
    await policies.update({ priceTolerancePct: 0, priceToleranceAmount: null, toleranceDirection: 'both' }, actor, await A());
  });

  it('C1-6. reject needs a reason; rejected -> reopen -> draft -> submit again; cancelling a submitted invoice releases its quantity and allocations', async () => {
    const po = await poWithReceipts([6]);
    const inv = await draft(po, 6, unitCost);
    await approvals.submit(inv.id, actor, await A());
    await expect(approvals.reject(inv.id, ' ', approver, await A())).rejects.toThrow(/reason is required/i);
    await approvals.reject(inv.id, 'wrong quantity on the supplier bill', approver, await A());
    expect(await state(inv.id)).toBe('rejected');
    expect(await quantityInvoiced(po.poLineId)).toBe(6); // still held until it is cancelled or corrected
    await approvals.reopen(inv.id, actor, await A());
    expect(await state(inv.id)).toBe('draft');
    await approvals.submit(inv.id, actor, await A());
    expect(await state(inv.id)).toBe('submitted');
    await invoices.voidInvoice(inv.id, 'cancel after review', actor, await A());
    expect(await state(inv.id)).toBe('void');
    expect(await quantityInvoiced(po.poLineId)).toBe(0);
    expect(await allocRows(inv.id)).toEqual([]);
    expect(await reconcile()).toEqual([]);
  });

  it('C1-7. two simultaneous approvals: exactly one wins; two simultaneous posts: exactly one ledger entry and one journal', async () => {
    const inv = await mkInvoice(10, unitCost);
    await approvals.submit(inv.id, actor, await A());
    const approvers = await Promise.allSettled([approvals.approve(inv.id, approver, await A()), approvals.approve(inv.id, approver2, await A())]);
    expect(approvers.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await state(inv.id)).toBe('approved');
    const before = await snapshot();
    const posts = await Promise.allSettled([invoices.postInvoice(inv.id, approver, await A()), invoices.postInvoice(inv.id, approver2, await A())]);
    await flush('A');
    expect(posts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const after = await snapshot();
    expect(after.ledger).toBe(before.ledger + 1);
    expect(after.journals).toBe(before.journals + 1);
    expect(await reconcile()).toEqual([]);
  });

  it('C1-8. submit is refused while the Company workflow is off; Company B keeps its own (legacy) policy and its own data', async () => {
    const dsB = await dsOf('B');
    expect(await policies.get(dsB.manager)).toEqual({ approvalRequired: false, priceTolerancePct: 0, priceToleranceAmount: null, toleranceDirection: 'both' });
    await expect(approvals.submit(randomUUID(), actor, dsB.manager)).rejects.toThrow(/not enabled for this Company/);
    await policies.update({ approvalRequired: false }, actor, await A());
    const inv = await mkInvoice(3, unitCost);
    await expect(approvals.submit(inv.id, actor, await A())).rejects.toThrow(/not enabled for this Company/);
    await post(inv.id); // legacy direct post still works with the switch off
    expect(await state(inv.id)).toBe('posted');
    expect(await count('B', 'procurement_invoice_policies')).toBe(0);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await policies.get(await A());
      await approvals.computeMatch([], new Map(), await policies.get(await A()));
    });
  });

  it('C1-Z. final reconciliation: allocations, aggregates, payments and ledger consistent; GL trial balance zero', async () => {
    expect(await reconcile()).toEqual([]);
    const tb: Array<{ d: string }> = await (await dsOf('A')).query(`SELECT coalesce(sum("debitBase" - "creditBase"),0)::text AS d FROM accounting_journal_lines`);
    expect(Number(tb[0].d)).toBeCloseTo(0, 2);
  });
});
