import { randomUUID } from 'crypto';
import { SupplierPaymentService } from '../application/supplier-payment.service';
import { SupplierPaymentReversalService } from '../application/supplier-payment-reversal.service';
import { SupplierLedgerService } from '../application/supplier-ledger.service';
import { SupplierInvoiceService } from '../application/supplier-invoice.service';
import { SUPPLIER_INVOICE_PROCESS } from '../domain/supplier-invoice-process';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../../accounting/application/journal-entry.service';
import { FinancialEventService } from '../../accounting/application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../../accounting/application/financial-events/handler-registry';
import { GLAccountService } from '../../accounting/application/gl-account.service';
import { FiscalPeriodService } from '../../accounting/application/fiscal-period.service';
import { CurrencyService } from '../../accounting/application/currency.service';
import { FinancialDimensionService } from '../../accounting/application/financial-dimension.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * T2-S (2026-10-21) — real-Postgres proof that a SUPPLIER payment is reversed THROUGH ITS OWNING DOCUMENT with Treasury, Supplier Ledger, invoice status and GL moving
 * together (and only together), that a multi-invoice allocated payment reverses per invoice, and that the raw Treasury reversal of the payment's leg is refused.
 *
 * NOTE: the three `reopen_*` transitions of `SUPPLIER_INVOICE_PROCESS` are the one change that lives in Procurement's own file; until that change is agreed and merged, this
 * spec adds them in memory (idempotently) so the reversal logic can be proven. Once the agreed change is in the file the shim is a no-op and can be deleted.
 */
function ensureAgreedReopenTransitions(): void {
  const want = [
    { from: 'paid', to: 'partially_paid', action: 'reopen_partial' },
    { from: 'paid', to: 'posted', action: 'reopen_paid' },
    { from: 'partially_paid', to: 'posted', action: 'reopen_paid' },
  ];
  for (const t of want) {
    if (!SUPPLIER_INVOICE_PROCESS.transitions.some((x) => x.from === t.from && x.to === t.to && x.action === t.action)) SUPPLIER_INVOICE_PROCESS.transitions.push(t);
  }
}

describe('T2-S — supplier payment reversal through the owning document — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let payments: SupplierPaymentService;
  let reversals: SupplierPaymentReversalService;
  let treasury: TreasuryService;
  let invoices: SupplierInvoiceService;
  const actor = randomUUID();
  const year = new Date().toISOString().slice(0, 4);
  type Key = 'A' | 'B';
  const ctx: Record<Key, { supplierId: string; bank1102: string; poId: string }> = { A: { supplierId: '', bank1102: '', poId: '' }, B: { supplierId: '', bank1102: '', poId: '' } };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function newInvoice(k: Key, total: string): Promise<string> {
    const ds = await dsOf(k);
    const id = randomUUID();
    await ds.query(`INSERT INTO "supplier_invoices" ("id","invoiceNumber","supplierId","purchaseOrderId","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,$5,$6)`, [id, `T2S-INV-${k}-${id.slice(0, 8)}`, ctx[k].supplierId, ctx[k].poId, total, actor]);
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'supplier_invoice_lifecycle','supplier_invoice',$2,'posted')`, [randomUUID(), id]);
    return id;
  }

  async function seed(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'T2S Operator',$2) ON CONFLICT DO NOTHING`, [actor, `t2s-${k}@test.local`]);
    for (const [code, name, type, normal, fn] of [
      ['1102', 'Bank', 'asset', 'debit', 'bank'],
      ['2101', 'Accounts Payable', 'liability', 'credit', 'ap'],
    ] as const) {
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
    const bankType = (await treasury.listAccountTypes(ds.manager)).find((t) => t.code === 'bank')!;
    const a = await treasury.createAccount(`BANK1102-${k}`, `Bank ${k}`, bankType.id, actor, ds.manager);
    await treasury.setAccountGlMapping(a.id, '1102', actor, ds.manager);
    ctx[k].bank1102 = a.id;
    const warehouseId = randomUUID();
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$3,'active')`, [warehouseId, `WH-T2S-${k}`, `T2S Warehouse ${k}`]);
    ctx[k].supplierId = randomUUID();
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,$2,$3)`, [ctx[k].supplierId, `T2S-SUP-${k}`, `T2S Supplier ${k}`]);
    ctx[k].poId = randomUUID();
    await ds.query(`INSERT INTO "purchase_orders" ("id","poNumber","supplierId","warehouseId") VALUES ($1,$2,$3,$4)`, [ctx[k].poId, `T2S-PO-${k}`, ctx[k].supplierId, warehouseId]);
    await treasury.cashIn(ctx[k].bank1102, '100000.00', null, null, null, 'T2S funding (non-emitting)', actor, ds.manager);
  }

  beforeAll(async () => {
    ensureAgreedReopenTransitions();
    h = await setUpTwoCompanyHarness({ namePrefix: 't2s_pay_reversal', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert, h.connections);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const config = { get: () => undefined } as unknown as ConfigurationEngineService;
    const currencies = new CurrencyService(h.controlPlane, audit);
    const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
    new FinancialEventService(h.controlPlane, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), config).onModuleInit();
    treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
    const ledger = new SupplierLedgerService(h.controlPlane, numbering, audit);
    invoices = new SupplierInvoiceService(h.controlPlane, numbering, processEngine, audit, ledger, events);
    payments = new SupplierPaymentService(h.controlPlane, numbering, audit, treasury, ledger, invoices, events);
    reversals = new SupplierPaymentReversalService(h.controlPlane, numbering, audit, ledger, invoices, processEngine, events, treasury);
    await seed('A');
    await seed('B');
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('T2S teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  const pay = async (k: Key, invoiceId: string, amount: string) => payments.recordPayment(ctx[k].supplierId, invoiceId, amount, 'bank_transfer', ctx[k].bank1102, null, actor, (await dsOf(k)).manager);
  const reverse = async (k: Key, paymentId: string, reason = 'wrong supplier') => reversals.reversePayment(paymentId, reason, actor, (await dsOf(k)).manager);
  const state = async (k: Key, invoiceId: string) => invoices.getStatus(invoiceId, (await dsOf(k)).manager);
  const remaining = async (k: Key, invoiceId: string) => invoices.getInvoiceRemaining(invoiceId, (await dsOf(k)).manager);
  const bal = async (k: Key) => treasury.getAccountBalance(ctx[k].bank1102, (await dsOf(k)).manager);
  async function gl(k: Key, code: string): Promise<string> {
    const ds = await dsOf(k);
    const r = await ds.query(
      `SELECT COALESCE(SUM(jl."debitBase" - jl."creditBase"),0)::numeric(20,2)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" JOIN "accounting_journal_entries" je ON je.id = jl."journalEntryId" AND je."postedAt" IS NOT NULL WHERE ga.code = $1`,
      [code],
    );
    return r[0].b;
  }
  async function fingerprint(k: Key) {
    const ds = await dsOf(k);
    const n = async (sql: string) => Number((await ds.query(sql))[0].n);
    return {
      treasuryTxns: await n(`SELECT count(*) AS n FROM "treasury_transactions"`),
      ledger: await n(`SELECT count(*) AS n FROM "supplier_ledger_entries"`),
      reversals: await n(`SELECT count(*) AS n FROM "supplier_payment_reversals"`),
      events: await n(`SELECT count(*) AS n FROM "accounting_financial_events"`),
      journals: await n(`SELECT count(*) AS n FROM "accounting_journal_entries"`),
      outbox: await n(`SELECT count(*) AS n FROM "event_outbox"`),
    };
  }

  it('S1 partial payment reversed: Treasury, ledger, invoice and GL return to their pre-payment values; the original rows stay, linked', async () => {
    const inv = await newInvoice('A', '900.00');
    const bBefore = await fingerprint('B');
    const bankBefore = await bal('A');
    const bank0 = await gl('A', '1102');
    const ap0 = await gl('A', '2101');
    const p = await pay('A', inv, '300.00');
    expect(await state('A', inv)).toBe('partially_paid');
    expect(await remaining('A', inv)).toBe('600.00');
    expect(Number(await bal('A'))).toBe(Number(bankBefore) - 300);

    const r = await reverse('A', p.id);
    expect(r.reversalNumber).toMatch(/^SPREV/);
    expect(await state('A', inv)).toBe('posted');
    expect(await remaining('A', inv)).toBe('900.00');
    expect(await bal('A')).toBe(bankBefore);
    expect(await gl('A', '1102')).toBe(bank0);
    expect(await gl('A', '2101')).toBe(ap0);

    const ds = await dsOf('A');
    const orig = await ds.query(`SELECT status FROM "treasury_transactions" WHERE id = $1`, [p.treasuryTransactionId]);
    expect(orig[0].status).toBe('reversed');
    const links = await ds.query(`SELECT count(*)::int AS n FROM "treasury_transactions" WHERE "reversalOfTransactionId" = $1`, [p.treasuryTransactionId]);
    expect(links[0].n).toBe(1);
    const ev = await ds.query(`SELECT status, "eventType" FROM "accounting_financial_events" WHERE "sourceEntityId" = $1 ORDER BY "receivedAt"`, [p.id]);
    expect(ev.map((e: { status: string; eventType: string }) => `${e.eventType}:${e.status}`)).toEqual(['finance.supplier_payment.recorded:POSTED', 'finance.supplier_payment.reversed:POSTED']);
    expect(await fingerprint('B')).toEqual(bBefore);
  });

  it('S2 a fully-paid invoice is re-opened (paid -> posted) and a reversal of one of two payments leaves it partially_paid', async () => {
    const inv1 = await newInvoice('A', '500.00');
    const p1 = await pay('A', inv1, '500.00');
    expect(await state('A', inv1)).toBe('paid');
    await reverse('A', p1.id);
    expect(await state('A', inv1)).toBe('posted');
    expect(await remaining('A', inv1)).toBe('500.00');

    const inv2 = await newInvoice('A', '900.00');
    const a = await pay('A', inv2, '400.00');
    const b = await pay('A', inv2, '500.00');
    expect(await state('A', inv2)).toBe('paid');
    await reverse('A', b.id);
    expect(await state('A', inv2)).toBe('partially_paid');
    expect(await remaining('A', inv2)).toBe('500.00');
    await reverse('A', a.id);
    expect(await state('A', inv2)).toBe('posted');
  });

  it('S3 one allocated payment over two invoices: the reversal re-opens BOTH, one Treasury leg back, one reversal event', async () => {
    const i1 = await newInvoice('A', '300.00');
    const i2 = await newInvoice('A', '200.00');
    const bankBefore = await bal('A');
    const ds = await dsOf('A');
    const p = await payments.recordPaymentAllocated(ctx.A.supplierId, [{ invoiceId: i1, amount: '300.00' }, { invoiceId: i2, amount: '150.00' }], 'bank_transfer', ctx.A.bank1102, null, actor, ds.manager);
    expect(await state('A', i1)).toBe('paid');
    expect(await state('A', i2)).toBe('partially_paid');
    const r = await reverse('A', p.id, 'allocated by mistake');
    expect([...r.invoicesReopened].sort()).toEqual([i1, i2].sort());
    expect(await state('A', i1)).toBe('posted');
    expect(await state('A', i2)).toBe('posted');
    expect(await remaining('A', i1)).toBe('300.00');
    expect(await remaining('A', i2)).toBe('200.00');
    expect(await bal('A')).toBe(bankBefore);
    const ev = await ds.query(`SELECT count(*)::int AS n FROM "accounting_financial_events" WHERE "sourceEntityId" = $1 AND "eventType" = 'finance.supplier_payment.reversed' AND status = 'POSTED'`, [p.id]);
    expect(ev[0].n).toBe(1);
  });

  it('S4 a second reversal is refused, and 5 concurrent reversals produce exactly one effect', async () => {
    const inv = await newInvoice('A', '200.00');
    const p = await pay('A', inv, '120.00');
    const before = await fingerprint('A');
    const results = await Promise.allSettled(Array.from({ length: 5 }, async () => reverse('A', p.id, 'concurrent')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const after = await fingerprint('A');
    expect(after.reversals - before.reversals).toBe(1);
    expect(after.treasuryTxns - before.treasuryTxns).toBe(1);
    expect(after.journals - before.journals).toBe(1);
    await expect(reverse('A', p.id)).rejects.toThrow(/already reversed/);
    expect(await remaining('A', inv)).toBe('200.00');
  });

  it("S5 reversing a supplier payment's Treasury leg DIRECTLY from the Treasury ledger is refused; nothing changes; the owning document still works", async () => {
    const inv = await newInvoice('A', '100.00');
    const p = await pay('A', inv, '100.00');
    const before = await fingerprint('A');
    await expect(treasury.reverseTransaction(p.treasuryTransactionId!, 'oops', actor, (await dsOf('A')).manager)).rejects.toThrow(/belongs to supplier payment SPAY.*reverse it through that document/);
    expect(await fingerprint('A')).toEqual(before);
    expect(await state('A', inv)).toBe('paid');
    await reverse('A', p.id);
    expect(await state('A', inv)).toBe('posted');
  });

  it('S6 refused BEFORE any change: closed period, blank reason, unknown payment, a payment of another Company', async () => {
    const ds = await dsOf('A');
    const inv = await newInvoice('A', '100.00');
    const p = await pay('A', inv, '100.00');
    const before = await fingerprint('A');

    await ds.query(`UPDATE "process_instances" SET "currentState" = 'closed' WHERE "definitionKey" = 'accounting_fiscal_period'`);
    await expect(reverse('A', p.id)).rejects.toThrow(/not open/);
    await ds.query(`UPDATE "process_instances" SET "currentState" = 'open' WHERE "definitionKey" = 'accounting_fiscal_period'`);
    expect(await fingerprint('A')).toEqual(before);

    await expect(reverse('A', p.id, ' ')).rejects.toThrow(/reason is required/);
    await expect(reverse('A', randomUUID())).rejects.toThrow(/not found/);
    await expect(reversals.reversePayment(p.id, 'cross company', actor, (await dsOf('B')).manager)).rejects.toThrow(/not found/);
    expect(await fingerprint('A')).toEqual(before);
    expect(await state('A', inv)).toBe('paid');
    await reverse('A', p.id);
  });

  it('S7 reconciliation after everything: AP subledger == GL AP, every journal balanced, no non-POSTED event, every reversed event has its record, Company B untouched', async () => {
    const ds = await dsOf('A');
    const apLedger = await ds.query(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END),0)::numeric(14,2)::text AS paid FROM "supplier_ledger_entries" WHERE "supplierPaymentId" IS NOT NULL`,
    );
    expect(apLedger[0].paid).toBe(await gl('A', '2101')); // payment-related AP movements in the subledger (debit = AP down) == their GL effect on AP
    const unbalanced = await ds.query(`SELECT count(*)::int AS n FROM "accounting_journal_entries" WHERE "postedAt" IS NOT NULL AND "totalDebitBase" <> "totalCreditBase"`);
    expect(unbalanced[0].n).toBe(0);
    const bad = await ds.query(`SELECT count(*)::int AS n FROM "accounting_financial_events" WHERE status <> 'POSTED'`);
    expect(bad[0].n).toBe(0);
    const reversalsWithoutRow = await ds.query(
      `SELECT count(*)::int AS n FROM "accounting_financial_events" e WHERE e."eventType" = 'finance.supplier_payment.reversed' AND NOT EXISTS (SELECT 1 FROM "supplier_payment_reversals" r WHERE r."supplierPaymentId"::text = e."sourceEntityId")`,
    );
    expect(reversalsWithoutRow[0].n).toBe(0);
    expect((await fingerprint('B')).reversals).toBe(0);
  });
});
