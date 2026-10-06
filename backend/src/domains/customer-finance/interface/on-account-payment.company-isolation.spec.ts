import { randomUUID } from 'crypto';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PaymentsService } from '../application/payments.service';
import { CustomersService } from '../../crm/application/customers.service';
import { CustomerLedgerService } from '../application/customer-ledger.service';
import { InvoiceService } from '../application/invoices.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../../accounting/application/journal-entry.service';
import { FinancialEventService } from '../../accounting/application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../../accounting/application/financial-events/handler-registry';
import { GLAccountService } from '../../accounting/application/gl-account.service';
import { FiscalPeriodService } from '../../accounting/application/fiscal-period.service';
import { CurrencyService } from '../../accounting/application/currency.service';
import { FinancialDimensionService } from '../../accounting/application/financial-dimension.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * CUS-01 (2026-10-06, CTO: Option 1) — on-account / advance customer payment on the EXISTING AR control architecture. Real PostgreSQL, Company
 * A with Company B as the witness, the real GL pipeline: a payment received before an invoice posts Dr [Treasury account's mapped GL] / Cr `ar`
 * (no new account), sits in the Customer Ledger as an unapplied credit (`invoiceId = NULL`), and is settled later by an explicit apply (partial
 * supported, append-only) or the existing invoice-post sweep. Every rejection happens before any mutation.
 */
describe('CUS-01 — on-account / advance customer payment (Cr existing AR control, unapplied → applied) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let payments: PaymentsService;
  let ledger: CustomerLedgerService;
  let treasury: TreasuryService;
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';
  const orderOwner = new Map<string, string>(); // sales order id → customer id (stub of the Sales order contract)
  const ctx: Record<Key, { customerId: string; otherCustomerId: string; inv1: string; inv2: string; invOther: string; invPaid: string; invSoX: string; soX: string; invSoY: string; soY: string; mapped: string; unmapped: string }> = {
    A: { customerId: '', otherCustomerId: '', inv1: '', inv2: '', invOther: '', invPaid: '', invSoX: '', soX: '', invSoY: '', soY: '', mapped: '', unmapped: '' },
    B: { customerId: '', otherCustomerId: '', inv1: '', inv2: '', invOther: '', invPaid: '', invSoX: '', soX: '', invSoY: '', soY: '', mapped: '', unmapped: '' },
  };
  const idOf = (k: Key) => (k === 'A' ? h.companyAId : h.companyBId);
  const dsOf = (k: Key) => h.connections.getDataSource(idOf(k));

  async function seed(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'CUS01 Operator',$2) ON CONFLICT DO NOTHING`, [actor, `cus01-${idOf(k)}@test.local`]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actor, role[0].id]);
    for (const [code, name, type, normal, fn] of [
      ['1101', 'Cash on Hand', 'asset', 'debit', 'bank'],
      ['1102', 'Bank', 'asset', 'debit', 'bank'],
      ['1110', 'Accounts Receivable', 'asset', 'debit', 'ar'],
    ]) {
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

    const types = await treasury.listAccountTypes(ds.manager);
    const bankType = types.find((t) => t.code === 'bank')!;
    const mk = async (code: string, gl: string | null) => {
      const a = await treasury.createAccount(`${code}-${k}`, `${code} ${k}`, bankType.id, actor, ds.manager);
      if (gl) await treasury.setAccountGlMapping(a.id, gl, actor, ds.manager);
      await treasury.cashIn(a.id, '5000.00', null, null, null, 'CUS01 funding', actor, ds.manager); // non-emitting funding
      return a.id;
    };
    ctx[k].mapped = await mk('BANK1102', '1102');
    ctx[k].unmapped = await mk('UNMAPPED', null);

    const customer = async (code: string) => {
      const id = randomUUID();
      await ds.query(`INSERT INTO "customers" ("id","code","name","creditLimit") VALUES ($1,$2,$3,'100000.00')`, [id, `${code}-${k}`, `${code} ${k}`]);
      return id;
    };
    ctx[k].customerId = await customer('CUS01');
    ctx[k].otherCustomerId = await customer('CUS01-OTHER');
    const invoice = async (customerId: string, label: string, total: string, state: string, salesOrderId: string = randomUUID()) => {
      const id = randomUUID();
      orderOwner.set(salesOrderId, customerId);
      await ds.query(
        `INSERT INTO "sales_invoices" ("id","invoiceNumber","customerId","salesOrderId","subtotal","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,$5,$5,$6)`,
        [id, `${label}-${k}`, customerId, salesOrderId, total, actor],
      );
      await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'sales_invoice_lifecycle','sales_invoice',$2,$3)`, [randomUUID(), id, state]);
      return { id, salesOrderId };
    };
    ctx[k].inv1 = (await invoice(ctx[k].customerId, 'C1-INV1', '900.00', 'posted')).id;
    ctx[k].inv2 = (await invoice(ctx[k].customerId, 'C1-INV2', '1200.00', 'posted')).id;
    ctx[k].invOther = (await invoice(ctx[k].otherCustomerId, 'C2-INV', '500.00', 'posted')).id;
    ctx[k].invPaid = (await invoice(ctx[k].customerId, 'C1-PAID', '100.00', 'paid')).id;
    ctx[k].soX = randomUUID();
    ctx[k].invSoX = (await invoice(ctx[k].customerId, 'C1-SOX', '1000.00', 'posted', ctx[k].soX)).id;
    ctx[k].soY = randomUUID();
    ctx[k].invSoY = (await invoice(ctx[k].customerId, 'C1-SOY', '1000.00', 'posted', ctx[k].soY)).id;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'cus01_on_account', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
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

    const dsA = await dsOf('A');
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const customers = new CustomersService(h.controlPlane, inert, inert, inert, inert, authorization, inert, inert);
    ledger = new CustomerLedgerService(h.controlPlane, numbering, audit, customers);
    const salesOrders = { getOrder: async (id: string) => ({ customerId: orderOwner.get(id) ?? '', warehouseId: null }) } as never;
    const invoices = new InvoiceService(h.controlPlane, numbering, processEngine, audit, salesOrders, customers, ledger, events, inert);
    payments = new PaymentsService(h.controlPlane, numbering, audit, treasury, ledger, invoices, events, customers);

    await seed('A');
    await seed('B');
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('CUS-01 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  async function fingerprint(k: Key) {
    const ds = await dsOf(k);
    const n = async (sql: string) => Number((await ds.query(sql))[0].n);
    return {
      treasuryTxns: await n(`SELECT count(*) AS n FROM "treasury_transactions"`),
      payments: await n(`SELECT count(*) AS n FROM "customer_payments"`),
      ledger: await n(`SELECT count(*) AS n FROM "customer_ledger_entries"`),
      events: await n(`SELECT count(*) AS n FROM "accounting_financial_events"`),
      journals: await n(`SELECT count(*) AS n FROM "accounting_journal_entries"`),
      outbox: await n(`SELECT count(*) AS n FROM "event_outbox"`),
    };
  }
  async function glLines(k: Key, sourceEntityId: string) {
    const ds = await dsOf(k);
    const ev: Array<{ status: string; journalEntryId: string | null }> = await ds.query(`SELECT status, "journalEntryId" FROM "accounting_financial_events" WHERE "sourceEntityId" = $1`, [sourceEntityId]);
    if (ev.length === 0) return null;
    if (!ev[0].journalEntryId) return { status: ev[0].status, lines: [] as string[] };
    const rows: Array<{ code: string; dr: string; cr: string }> = await ds.query(
      `SELECT ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY ga.code`,
      [ev[0].journalEntryId],
    );
    return { status: ev[0].status, lines: rows.map((r) => (Number(r.dr) > 0 ? `${r.code} D ${Number(r.dr).toFixed(2)}` : `${r.code} C ${Number(r.cr).toFixed(2)}`)) };
  }
  const onAccount = async (k: Key, amount: string, opts: { customerId?: string; salesOrderId?: string | null; account?: string } = {}) =>
    payments.recordOnAccountPayment(opts.customerId ?? ctx[k].customerId, opts.salesOrderId ?? null, amount, 'bank_transfer', opts.account ?? ctx[k].mapped, null, actor, (await dsOf(k)).manager);
  const invoiceRemaining = async (k: Key, invoiceId: string) => payments['invoices'].getInvoiceRemaining(invoiceId, (await dsOf(k)).manager);
  const invoiceState = async (k: Key, invoiceId: string) => (await (await dsOf(k)).query(`SELECT "currentState" FROM process_instances WHERE "entityId" = $1 AND "entityType" = 'sales_invoice'`, [invoiceId]))[0].currentState as string;

  let p1 = '';

  it('1. RECEIVE before any invoice: Dr mapped bank (1102) / Cr the EXISTING ar control (1110) — no new account; unapplied credit in the Customer Ledger; the invoice is untouched', async () => {
    const bBefore = await fingerprint('B');
    let p!: Awaited<ReturnType<typeof onAccount>>;
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      p = await onAccount('A', '500.00');
    });
    p1 = p.id;
    expect(p.invoiceId).toBeNull();
    expect(await glLines('A', p.id)).toEqual({ status: 'POSTED', lines: ['1102 D 500.00', '1110 C 500.00'] });
    const ds = await dsOf('A');
    const rows = await ds.query(`SELECT "entryType", direction, amount::text AS amount, "invoiceId" FROM customer_ledger_entries WHERE "paymentId" = $1`, [p.id]);
    expect(rows).toEqual([{ entryType: 'payment', direction: 'credit', amount: '500.00', invoiceId: null }]);
    expect(await payments.getUnappliedBalance(p.id, ds.manager)).toBe('500.00');
    expect(await invoiceRemaining('A', ctx.A.inv1)).toBe('900.00'); // nothing applied yet
    expect((await payments.listUnappliedPayments(actor, ctx.A.customerId, ds.manager)).map((x) => [x.id, x.unappliedAmount])).toEqual([[p.id, '500.00']]);
    expect(await fingerprint('B')).toEqual(bBefore);
  });

  it('2. FAIL CLOSED before any mutation: amount ≤ 0, unmapped Treasury account, a sales order of another customer, an unknown customer — zero treasury / payment / ledger / event / journal / outbox rows', async () => {
    const before = await fingerprint('A');
    await expect(onAccount('A', '0')).rejects.toThrow(/positive/);
    await expect(onAccount('A', '-5.00')).rejects.toThrow(/positive/);
    await expect(onAccount('A', '10.00', { account: ctx.A.unmapped })).rejects.toThrow(/not GL-mapped/);
    const foreignOrder = [...orderOwner.entries()].find(([, c]) => c === ctx.A.otherCustomerId)![0];
    await expect(onAccount('A', '10.00', { salesOrderId: foreignOrder })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(onAccount('A', '10.00', { customerId: randomUUID() })).rejects.toThrow(); // the existing customer lookup's own not-found error (same as recordPayment)
    expect(await fingerprint('A')).toEqual(before);
  });

  it('3. EXPLICIT PARTIAL APPLY (append-only): 200 of the 500 goes to invoice 1 — two new application rows, the original row untouched, invoice partially_paid, customer balance and GL unchanged', async () => {
    const ds = await dsOf('A');
    const balanceBefore = await ledger.getCustomerBalance(ctx.A.customerId, ds.manager);
    const before = await fingerprint('A');
    const original = await ds.query(`SELECT * FROM customer_ledger_entries WHERE "paymentId" = $1 AND "entryType" = 'payment'`, [p1]);

    const r = await payments.applyPayment(p1, ctx.A.inv1, '200.00', actor, ds.manager);
    expect(r).toMatchObject({ applied: '200.00', unappliedRemaining: '300.00', invoiceRemaining: '700.00' });
    expect(await payments.getUnappliedBalance(p1, ds.manager)).toBe('300.00');
    expect(await invoiceRemaining('A', ctx.A.inv1)).toBe('700.00');
    expect(await invoiceState('A', ctx.A.inv1)).toBe('partially_paid');
    expect(await ledger.getCustomerBalance(ctx.A.customerId, ds.manager)).toBe(balanceBefore); // net customer balance unchanged
    const after = await fingerprint('A');
    expect({ ...after, ledger: after.ledger - 2 }).toEqual(before); // exactly two ledger rows added; no treasury / payment / event / journal / outbox change (no GL: the credit already sits in AR)
    expect(await ds.query(`SELECT * FROM customer_ledger_entries WHERE "paymentId" = $1 AND "entryType" = 'payment'`, [p1])).toEqual(original); // append-only: original row not modified
    const appl = await ds.query(`SELECT direction, amount::text AS amount, "invoiceId" FROM customer_ledger_entries WHERE "paymentId" = $1 AND "entryType" = 'payment_application' ORDER BY direction`, [p1]);
    expect(appl).toEqual([{ direction: 'credit', amount: '200.00', invoiceId: ctx.A.inv1 }, { direction: 'debit', amount: '200.00', invoiceId: null }]);

    await payments.applyPayment(p1, ctx.A.inv1, '300.00', actor, ds.manager); // the rest, same invoice
    expect(await payments.getUnappliedBalance(p1, ds.manager)).toBe('0.00');
    expect(await invoiceRemaining('A', ctx.A.inv1)).toBe('400.00');
    expect(await payments.listUnappliedPayments(actor, ctx.A.customerId, ds.manager)).toEqual([]);
  });

  it('4. APPLY REJECTIONS before any mutation: > unapplied, > invoice outstanding, ≤ 0, another customer\'s invoice, a paid invoice, an unknown payment', async () => {
    const ds = await dsOf('A');
    const p2 = await onAccount('A', '1000.00');
    const before = await fingerprint('A');
    await expect(payments.applyPayment(p2.id, ctx.A.inv2, '1000.01', actor, ds.manager)).rejects.toThrow(/only 1000\.00 of payment/); // > unapplied
    await expect(payments.applyPayment(p2.id, ctx.A.inv1, '1000.00', actor, ds.manager)).rejects.toThrow(/only 400\.00 remains on invoice/); // > invoice outstanding (400)
    await expect(payments.applyPayment(p2.id, ctx.A.inv2, '0', actor, ds.manager)).rejects.toThrow(/positive/);
    await expect(payments.applyPayment(p2.id, ctx.A.invOther, '10.00', actor, ds.manager)).rejects.toBeInstanceOf(ForbiddenException); // other customer's invoice
    await expect(payments.applyPayment(p2.id, ctx.A.invPaid, '10.00', actor, ds.manager)).rejects.toBeInstanceOf(ConflictException); // not open
    await expect(payments.applyPayment(randomUUID(), ctx.A.inv2, '10.00', actor, ds.manager)).rejects.toBeInstanceOf(NotFoundException);
    expect(await fingerprint('A')).toEqual(before);
    expect(await payments.getUnappliedBalance(p2.id, ds.manager)).toBe('1000.00');
    // an invoice-bound payment has nothing unapplied to apply
    const bound = await payments.recordPayment(ctx.A.customerId, ctx.A.inv2, '100.00', 'bank_transfer', ctx.A.mapped, null, actor, ds.manager);
    await expect(payments.applyPayment(bound.id, ctx.A.inv2, '10.00', actor, ds.manager)).rejects.toThrow(/only 0\.00 of payment/);
  });

  it('5. AUTOMATIC settlement (existing sweep): a payment earmarked to a sales order is settled when that order\'s invoice is posted; a PARTIALLY applied receipt is never swept (no double application)', async () => {
    const ds = await dsOf('A');
    const px = await onAccount('A', '250.00', { salesOrderId: ctx.A.soX });
    expect(await payments.getUnappliedBalance(px.id, ds.manager)).toBe('250.00');
    const soXInvoice = (await ds.query(`SELECT "salesOrderId" FROM sales_invoices WHERE id = $1`, [ctx.A.invSoX]))[0].salesOrderId;
    await ledger.sweepUnappliedFor(ctx.A.customerId, soXInvoice, ctx.A.invSoX, ds.manager);
    expect(await payments.getUnappliedBalance(px.id, ds.manager)).toBe('0.00');
    expect(await invoiceRemaining('A', ctx.A.invSoX)).toBe('750.00');

    const py = await onAccount('A', '400.00', { salesOrderId: ctx.A.soY });
    await payments.applyPayment(py.id, ctx.A.inv2, '100.00', actor, ds.manager); // explicit partial first
    const soYInvoice = (await ds.query(`SELECT "salesOrderId" FROM sales_invoices WHERE id = $1`, [ctx.A.invSoY]))[0].salesOrderId;
    await ledger.sweepUnappliedFor(ctx.A.customerId, soYInvoice, ctx.A.invSoY, ds.manager);
    expect(await payments.getUnappliedBalance(py.id, ds.manager)).toBe('300.00'); // remainder NOT swept
    expect(await invoiceRemaining('A', ctx.A.invSoY)).toBe('1000.00');
  });

  it('6. RECONCILIATION — AR: the Customer Ledger total equals the GL `ar` control balance (applications change neither); TREASURY: the account balance movement equals the GL bank-leg debits', async () => {
    const ds = await dsOf('A');
    const ledgerTotal = Number((await ds.query(`SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0) AS t FROM customer_ledger_entries`))[0].t);
    const glAr = Number((await ds.query(`SELECT COALESCE(SUM(jl."debitBase" - jl."creditBase"), 0) AS t FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE ga.code = '1110'`))[0].t);
    expect(glAr).toBeCloseTo(-(500 + 1000 + 100 + 250 + 400), 2);
    expect(ledgerTotal).toBeCloseTo(glAr, 2); // AR sub-ledger ↔ GL: reconciled, including the unapplied credits and the applications

    const glBank = Number((await ds.query(`SELECT COALESCE(SUM(jl."debitBase" - jl."creditBase"), 0) AS t FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE ga.code = '1102'`))[0].t);
    const treasuryBalance = Number(await treasury.getAccountBalance(ctx.A.mapped, ds.manager));
    expect(treasuryBalance - 5000).toBeCloseTo(glBank, 2); // Treasury ↔ GL bank leg (funding of 5000 is the non-emitting opening)
    expect(await ds.query(`SELECT 1 FROM accounting_financial_events WHERE status <> 'POSTED'`)).toEqual([]); // every event posted
  });

  it('7. ISOLATION: B\'s on-account flow posts only in B; A\'s payment/invoice ids are unknown to B; A is unchanged by B; the Platform DB was never used', async () => {
    const dsB = await dsOf('B');
    const aBefore = await fingerprint('A');
    const pb = await onAccount('B', '300.00');
    expect(await glLines('B', pb.id)).toEqual({ status: 'POSTED', lines: ['1102 D 300.00', '1110 C 300.00'] });
    await payments.applyPayment(pb.id, ctx.B.inv1, '120.00', actor, dsB.manager);
    expect(await payments.getUnappliedBalance(pb.id, dsB.manager)).toBe('180.00');
    await expect(payments.applyPayment(p1, ctx.B.inv1, '10.00', actor, dsB.manager)).rejects.toBeInstanceOf(NotFoundException); // A's payment id
    await expect(payments.applyPayment(pb.id, ctx.A.inv1, '10.00', actor, dsB.manager)).rejects.toBeInstanceOf(NotFoundException); // A's invoice id
    expect(await fingerprint('A')).toEqual(aBefore);
    expect((await payments.listUnappliedPayments(actor, undefined, dsB.manager)).map((x) => x.id)).toEqual([pb.id]);
    expect(Number((await h.controlPlane.query(`SELECT count(*) AS n FROM "event_outbox"`))[0].n)).toBe(0);
  });
});
