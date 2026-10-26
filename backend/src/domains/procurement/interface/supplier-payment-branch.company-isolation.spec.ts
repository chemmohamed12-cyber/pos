import { randomUUID } from 'crypto';
import { SupplierPaymentService } from '../application/supplier-payment.service';
import { SupplierPaymentReversalService } from '../application/supplier-payment-reversal.service';
import { SupplierLedgerService } from '../application/supplier-ledger.service';
import { SupplierInvoiceService } from '../application/supplier-invoice.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../../accounting/application/journal-entry.service';
import { FinancialEventService } from '../../accounting/application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../../accounting/application/financial-events/handler-registry';
import { handleSupplierPaymentRecorded } from '../../accounting/application/financial-events/supplier-invoice.handler';
import { handleSupplierPaymentReversed } from '../../accounting/application/financial-events/supplier-payment-reversed.handler';
import { readPaymentAllocations } from '../../accounting/application/financial-events/supplier-payment-allocations';
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
 * Org engine WP-A (decision D-A option B) — real PostgreSQL. A supplier payment is attributed per LINE: the Accounts-payable side one line per invoice branch (so branch AP
 * balances relieve in their own branch), the bank side one line on the paying account's branch; the whole entry carries no unit; the reversal mirrors exactly what was stamped
 * when the payment was recorded; a v1 payload (recorded before the decision) keeps the single unit-less pair; inconsistent allocations are rejected, never guessed.
 */
describe('WP-A — supplier payment attribution by branch — real-Postgres', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let payments: SupplierPaymentService;
  let reversals: SupplierPaymentReversalService;
  let treasury: TreasuryService;
  const actor = randomUUID();
  const year = new Date().toISOString().slice(0, 4);
  const ids = { root: randomUUID(), x: randomUUID(), y: randomUUID(), supplier: '', poX: randomUUID(), poY: randomUUID(), poNone: randomUUID(), bankX: '', bankNone: '' };
  const dsA = () => h.connections.getDataSource(h.companyAId);

  async function newInvoice(po: string, total: string): Promise<string> {
    const ds = await dsA();
    const id = randomUUID();
    await ds.query(`INSERT INTO "supplier_invoices" ("id","invoiceNumber","supplierId","purchaseOrderId","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,$5,$6)`, [id, `WPA-INV-${id.slice(0, 8)}`, ids.supplier, po, total, actor]);
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'supplier_invoice_lifecycle','supplier_invoice',$2,'posted')`, [randomUUID(), id]);
    return id;
  }
  async function lines(paymentId: string, eventType: string) {
    const ds = await dsA();
    return ds.query(
      `SELECT ga.code, jl."orgUnitId" AS unit, jl."debitBase"::text AS debit, jl."creditBase"::text AS credit, je."orgUnitId" AS "entryUnit"
         FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" JOIN "accounting_journal_entries" je ON je.id = jl."journalEntryId"
         JOIN "accounting_financial_events" fe ON fe.id = je."financialEventId"
        WHERE fe."sourceEntityId" = $1 AND fe."eventType" = $2 AND fe.status = 'POSTED' ORDER BY ga.code DESC, jl."orgUnitId" NULLS FIRST`,
      [paymentId, eventType],
    );
  }
  const num = (v: string) => Number(v);
  const apNet = async (unit: string | null) => {
    const ds = await dsA();
    const r = await ds.query(`SELECT COALESCE(SUM(jl."debitBase" - jl."creditBase"),0)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE ga.code = '2101' AND jl."orgUnitId" IS NOT DISTINCT FROM $1`, [unit]);
    return num(r[0].b);
  };

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'wpa_pay_branch', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
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
    const invoices = new SupplierInvoiceService(h.controlPlane, numbering, processEngine, audit, ledger, events);
    payments = new SupplierPaymentService(h.controlPlane, numbering, audit, treasury, ledger, invoices, events);
    reversals = new SupplierPaymentReversalService(h.controlPlane, numbering, audit, ledger, invoices, processEngine, events, treasury);

    const ds = await dsA();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'WPA Operator','wpa@test.local')`, [actor]);
    for (const [code, name, type, normal, fn] of [['1102', 'Bank', 'asset', 'debit', 'bank'], ['2101', 'Accounts Payable', 'liability', 'credit', 'ap']] as const) {
      await ds.query(`INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`, [randomUUID(), code, name, type, normal, fn]);
    }
    const fy = randomUUID();
    const fp = randomUUID();
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`, [randomUUID(), fy, randomUUID(), fp]);
    await numbering.registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
    await ds.query(`INSERT INTO org_units (id,type,name) VALUES ($1,'company','Root')`, [ids.root]);
    await ds.query(`INSERT INTO org_units (id,type,name,"parentId") VALUES ($1,'branch','X',$3),($2,'branch','Y',$3)`, [ids.x, ids.y, ids.root]);
    const bankType = (await treasury.listAccountTypes(ds.manager)).find((t) => t.code === 'bank')!;
    for (const [key, unit] of [['bankX', ids.x], ['bankNone', null]] as const) {
      const a = await treasury.createAccount(`BANK-${key}`, key, bankType.id, actor, ds.manager, unit);
      await treasury.setAccountGlMapping(a.id, '1102', actor, ds.manager);
      await treasury.cashIn(a.id, '100000.00', null, null, null, 'WPA funding (non-emitting)', actor, ds.manager);
      ids[key] = a.id;
    }
    const wh = randomUUID();
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-WPA','WPA wh','active')`, [wh]);
    ids.supplier = randomUUID();
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,'WPA-SUP','WPA Supplier')`, [ids.supplier]);
    for (const [po, unit, n] of [[ids.poX, ids.x, 'X'], [ids.poY, ids.y, 'Y'], [ids.poNone, null, 'N']] as const) {
      await ds.query(`INSERT INTO "purchase_orders" ("id","poNumber","supplierId","warehouseId","orgUnitId") VALUES ($1,$2,$3,$4,$5)`, [po, `WPA-PO-${n}`, ids.supplier, wh, unit]);
    }
  });
  afterAll(async () => h.teardown().catch(() => undefined));

  const payAlloc = async (alloc: Array<{ invoiceId: string; amount: string }>, bank: string) => payments.recordPaymentAllocated(ids.supplier, alloc, 'bank_transfer', bank, null, actor, (await dsA()).manager);

  it('single-branch invoice: AP line on the invoice branch, bank line on the paying account branch, entry itself unit-less', async () => {
    const inv = await newInvoice(ids.poX, '500.00');
    const p = await payAlloc([{ invoiceId: inv, amount: '200.00' }], ids.bankX);
    const l = await lines(p.id, 'finance.supplier_payment.recorded');
    expect(l.map((r: { code: string; unit: string | null; debit: string; credit: string }) => `${r.code}:${r.unit === ids.x ? 'X' : r.unit}:${num(r.debit)}/${num(r.credit)}`)).toEqual(['2101:X:200/0', '1102:X:0/200']);
    expect(l.every((r: { entryUnit: string | null }) => r.entryUnit === null)).toBe(true);
    const ds = await dsA();
    expect((await ds.query(`SELECT "bankOrgUnitId" FROM supplier_payments WHERE id=$1`, [p.id]))[0].bankOrgUnitId).toBe(ids.x);
    expect((await ds.query(`SELECT "orgUnitId" FROM supplier_payment_allocations WHERE "supplierPaymentId"=$1`, [p.id]))[0].orgUnitId).toBe(ids.x);
  });

  it('mixed branches: AP split per invoice branch (X 300 + Y 200), ONE bank line of 500 on the account branch, entry balanced', async () => {
    const iX = await newInvoice(ids.poX, '300.00');
    const iY = await newInvoice(ids.poY, '200.00');
    const p = await payAlloc([{ invoiceId: iX, amount: '300.00' }, { invoiceId: iY, amount: '200.00' }], ids.bankX);
    const l = await lines(p.id, 'finance.supplier_payment.recorded');
    const byUnit = (code: string) => Object.fromEntries(l.filter((r: { code: string }) => r.code === code).map((r: { unit: string; debit: string; credit: string }) => [r.unit === ids.x ? 'X' : r.unit === ids.y ? 'Y' : String(r.unit), num(r.debit) || num(r.credit)]));
    expect(byUnit('2101')).toEqual({ X: 300, Y: 200 });
    expect(byUnit('1102')).toEqual({ X: 500 });
    const debit = l.reduce((s: number, r: { debit: string }) => s + num(r.debit), 0);
    const credit = l.reduce((s: number, r: { credit: string }) => s + num(r.credit), 0);
    expect(debit).toBe(credit);
  });

  it('unassigned invoice + assigned invoice, unassigned bank account: NULL group stays NULL (no default branch), the other keeps its branch', async () => {
    const iN = await newInvoice(ids.poNone, '100.00');
    const iY = await newInvoice(ids.poY, '50.00');
    const p = await payAlloc([{ invoiceId: iN, amount: '100.00' }, { invoiceId: iY, amount: '50.00' }], ids.bankNone);
    const l = await lines(p.id, 'finance.supplier_payment.recorded');
    expect(l.map((r: { code: string; unit: string | null }) => `${r.code}:${r.unit === null ? 'null' : r.unit === ids.y ? 'Y' : '?'}`)).toEqual(['2101:null', '2101:Y', '1102:null']);
  });

  it('the reversal mirrors the STAMPED attribution line by line (even if the account/invoice branch changed since) and AP nets to zero in every unit', async () => {
    const before = { x: await apNet(ids.x), y: await apNet(ids.y) };
    const iX = await newInvoice(ids.poX, '400.00');
    const iY = await newInvoice(ids.poY, '250.00');
    const p = await payAlloc([{ invoiceId: iX, amount: '400.00' }, { invoiceId: iY, amount: '250.00' }], ids.bankX);
    const ds = await dsA();
    await ds.query(`UPDATE treasury_accounts SET "orgUnitId" = $1 WHERE id = $2`, [ids.y, ids.bankX]); // the account moves to branch Y AFTER the payment
    await ds.query(`UPDATE purchase_orders SET "orgUnitId" = $1 WHERE id = $2`, [ids.y, ids.poX]); // and an invoice's PO too
    await reversals.reversePayment(p.id, 'wrong supplier', actor, ds.manager);
    const rev = await lines(p.id, 'finance.supplier_payment.reversed');
    const orig = await lines(p.id, 'finance.supplier_payment.recorded');
    const key = (r: { code: string; unit: string | null; debit: string; credit: string }) => `${r.code}|${r.unit}|${num(r.credit)}|${num(r.debit)}`; // mirror: debit<->credit swapped
    expect(rev.map((r: { code: string; unit: string | null; debit: string; credit: string }) => `${r.code}|${r.unit}|${num(r.debit)}|${num(r.credit)}`).sort()).toEqual(orig.map(key).sort());
    expect(await apNet(ids.x)).toBe(before.x);
    expect(await apNet(ids.y)).toBe(before.y);
    await ds.query(`UPDATE treasury_accounts SET "orgUnitId" = $1 WHERE id = $2`, [ids.x, ids.bankX]);
    await ds.query(`UPDATE purchase_orders SET "orgUnitId" = $1 WHERE id = $2`, [ids.x, ids.poX]);
  });

  it('v1 payloads (recorded before the decision) keep the single unit-less pair, for the payment and for its reversal; inconsistent allocations are rejected', async () => {
    const ctx = { findAccountByCode: async (c: string) => `acct-${c}`, resolveControlAccount: async () => 'acct-ap' } as never;
    const base = { businessDate: '2026-01-01', transactionCurrencyCode: 'EGP', orgUnitId: null, sourceEntityId: 'p1', payload: { amount: '100.00', apAccountCode: '2101', glAccountCode: '1102', paymentNumber: 'SP-1', reversalNumber: 'SPREV-1' } };
    const rec = await handleSupplierPaymentRecorded(base as never, { ...(ctx as object), resolveControlAccount: async () => 'acct-ap', findAccountByCode: async (c: string) => `acct-${c}` } as never);
    expect(rec.kind).toBe('draft');
    if (rec.kind === 'draft') expect(rec.draft.lines).toEqual([{ accountId: 'acct-2101', debit: '100.00', description: 'Accounts payable' }, { accountId: 'acct-1102', credit: '100.00', description: 'Cash / bank' }].map((x) => expect.objectContaining(x)));
    const rv = await handleSupplierPaymentReversed(base as never, { findAccountByCode: async (c: string) => `acct-${c}`, resolveControlAccount: async () => 'acct-ap' } as never);
    expect(rv.kind).toBe('draft');
    if (rv.kind === 'draft') expect(rv.draft.lines.map((l) => l.orgUnitId)).toEqual([undefined, undefined]);
    expect(readPaymentAllocations({}, '100.00')).toBeNull();
    expect(readPaymentAllocations({ allocations: [{ amount: '60.00', orgUnitId: 'u1' }] }, '100.00')).toEqual({ ok: false, reason: expect.stringContaining('do not add up') });
    expect(readPaymentAllocations({ allocations: [] }, '100.00')).toEqual({ ok: false, reason: 'allocations are empty' });
    expect(readPaymentAllocations({ allocations: [{ amount: 'x', orgUnitId: null }] }, '100.00')).toEqual({ ok: false, reason: expect.stringContaining('invalid amount') });
    const bad = await handleSupplierPaymentRecorded({ ...base, payload: { ...base.payload, allocations: [{ amount: '60.00', orgUnitId: 'u1' }] } } as never, { findAccountByCode: async (c: string) => `acct-${c}`, resolveControlAccount: async () => 'acct-ap' } as never);
    expect(bad).toEqual({ kind: 'rejected', reason: expect.stringContaining('do not add up') });
  });

  it('Company B (the second harness database) is untouched', async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect(Number((await dsB.query(`SELECT count(*)::int AS n FROM supplier_payments`))[0].n)).toBe(0);
  });
});
