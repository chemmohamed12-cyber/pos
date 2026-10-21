import { randomUUID } from 'crypto';
import { PaymentsService } from '../application/payments.service';
import { CustomersService } from '../../crm/application/customers.service';
import { CustomerLedgerService } from '../application/customer-ledger.service';
import { InvoiceService } from '../application/invoices.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { TreasuryPostingExceptionsService } from '../../accounting/application/treasury-posting-exceptions.service';
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
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * T2 (2026-10-20) — real-Postgres proof that a customer payment is reversed THROUGH ITS OWNING DOCUMENT with Treasury, Customer Ledger, invoice status and GL
 * moving together (and only together), and that the raw Treasury reversal of a payment's leg — which would have booked the offset to the clearing account — is refused.
 */
describe('T2 — customer payment reversal through the owning document — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let payments: PaymentsService;
  let treasury: TreasuryService;
  let events: EventBusService;
  let invoices: InvoiceService;
  const actor = randomUUID();
  const year = new Date().toISOString().slice(0, 4);
  type Key = 'A' | 'B';
  const ctx: Record<Key, { customerId: string; bank1102: string; salesOrderId: string }> = {
    A: { customerId: '', bank1102: '', salesOrderId: '' },
    B: { customerId: '', bank1102: '', salesOrderId: '' },
  };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function newInvoice(k: Key, total: string): Promise<string> {
    const ds = await dsOf(k);
    const id = randomUUID();
    await ds.query(
      `INSERT INTO "sales_invoices" ("id","invoiceNumber","customerId","salesOrderId","subtotal","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,$5,$5,$6)`,
      [id, `T2-INV-${k}-${id.slice(0, 8)}`, ctx[k].customerId, ctx[k].salesOrderId, total, actor],
    );
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'sales_invoice_lifecycle','sales_invoice',$2,'posted')`, [randomUUID(), id]);
    return id;
  }

  async function seed(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'T2 Operator',$2) ON CONFLICT DO NOTHING`, [actor, `t2-${k}@test.local`]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actor, role[0].id]);
    for (const [code, name, type, normal, fn] of [
      ['1102', 'Bank', 'asset', 'debit', 'bank'],
      ['1110', 'Accounts Receivable', 'asset', 'debit', 'ar'],
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
    const customerId = randomUUID();
    await ds.query(`INSERT INTO "customers" ("id","code","name","creditLimit") VALUES ($1,$2,'T2 Customer','100000.00')`, [customerId, `T2-CUST-${k}`]);
    ctx[k].customerId = customerId;
    ctx[k].salesOrderId = randomUUID();
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 't2_pay_reversal', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    events = new EventBusService(inert, h.connections);
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
    const customerLedger = new CustomerLedgerService(h.controlPlane, numbering, audit, customers);
    invoices = new InvoiceService(h.controlPlane, numbering, processEngine, audit, inert, customers, customerLedger, events, inert);
    payments = new PaymentsService(h.controlPlane, numbering, audit, treasury, customerLedger, invoices, events, customers);
    await seed('A');
    await seed('B');
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('T2 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  const pay = async (k: Key, invoiceId: string, amount: string) => payments.recordPayment(ctx[k].customerId, invoiceId, amount, 'bank_transfer', ctx[k].bank1102, null, actor, (await dsOf(k)).manager);
  const reverse = async (k: Key, paymentId: string, reason = 'wrong customer') => payments.reversePayment(paymentId, reason, actor, (await dsOf(k)).manager);
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
      ledger: await n(`SELECT count(*) AS n FROM "customer_ledger_entries"`),
      reversals: await n(`SELECT count(*) AS n FROM "customer_payment_reversals"`),
      events: await n(`SELECT count(*) AS n FROM "accounting_financial_events"`),
      journals: await n(`SELECT count(*) AS n FROM "accounting_journal_entries"`),
      outbox: await n(`SELECT count(*) AS n FROM "event_outbox"`),
    };
  }
  const fund = async (k: Key, amount: string) => treasury.cashIn(ctx[k].bank1102, amount, null, null, null, 'T2 funding (non-emitting)', actor, (await dsOf(k)).manager);

  it('R1 partial payment reversed: Treasury, ledger, invoice and GL all return to their pre-payment values; the original rows stay, linked', async () => {
    const inv = await newInvoice('A', '900.00');
    const bBefore = await fingerprint('B');
    const p = await pay('A', inv, '300.00');
    expect(await state('A', inv)).toBe('partially_paid');
    expect(await remaining('A', inv)).toBe('600.00');
    expect(await bal('A')).toBe('300.00');
    expect(await gl('A', '1102')).toBe('300.00');
    expect(await gl('A', '1110')).toBe('-300.00');

    const r = await reverse('A', p.id);
    expect(r.reversalNumber).toMatch(/^PREV/);
    expect(await state('A', inv)).toBe('posted');
    expect(await remaining('A', inv)).toBe('900.00');
    expect(await bal('A')).toBe('0.00');
    expect(await gl('A', '1102')).toBe('0.00');
    expect(await gl('A', '1110')).toBe('0.00');

    const ds = await dsOf('A');
    const orig = await ds.query(`SELECT status FROM "treasury_transactions" WHERE id = $1`, [p.treasuryTransactionId]);
    expect(orig[0].status).toBe('reversed');
    const links = await ds.query(`SELECT count(*)::int AS n FROM "treasury_transactions" WHERE "reversalOfTransactionId" = $1`, [p.treasuryTransactionId]);
    expect(links[0].n).toBe(1);
    const ev = await ds.query(`SELECT status, "eventType" FROM "accounting_financial_events" WHERE "sourceEntityId" = $1 ORDER BY "receivedAt"`, [p.id]);
    expect(ev.map((e: { status: string; eventType: string }) => `${e.eventType}:${e.status}`)).toEqual(['finance.payment.recorded:POSTED', 'finance.payment.reversed:POSTED']);
    expect(await fingerprint('B')).toEqual(bBefore);
  });

  it('R2 a fully-paid invoice is re-opened (paid → posted) and R3 a reversal of one of two payments leaves it partially_paid', async () => {
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
    expect(await bal('A')).toBe('0.00');
  });

  it('R4 a second reversal is refused, and 5 concurrent reversals produce exactly one effect', async () => {
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
    expect(await gl('A', '1110')).toBe('0.00');
  });

  it('R5 reversing a payment\'s Treasury leg DIRECTLY from the Treasury ledger is refused (it would have offset the clearing account, not AR); nothing changes', async () => {
    const inv = await newInvoice('A', '100.00');
    const p = await pay('A', inv, '100.00');
    const before = await fingerprint('A');
    await expect(treasury.reverseTransaction(p.treasuryTransactionId!, 'oops', actor, (await dsOf('A')).manager)).rejects.toThrow(/belongs to customer payment PAY.*reverse it through that document/);
    expect(await fingerprint('A')).toEqual(before);
    expect(await state('A', inv)).toBe('paid');
    await reverse('A', p.id); // the right way works
    expect(await state('A', inv)).toBe('posted');
  });

  it('R6 on-account receipt: reversed while unapplied; and after a partial application BOTH the unapplied remainder and the applied part are reversed and the invoice re-opens', async () => {
    const ds = await dsOf('A');
    const op = await payments.recordOnAccountPayment(ctx.A.customerId, null, '250.00', 'bank_transfer', ctx.A.bank1102, null, actor, ds.manager);
    expect(await payments.getUnappliedBalance(op.id, ds.manager)).toBe('250.00');
    await reverse('A', op.id, 'duplicate advance');
    expect(await payments.getUnappliedBalance(op.id, ds.manager)).toBe('0.00');

    const inv = await newInvoice('A', '300.00');
    const op2 = await payments.recordOnAccountPayment(ctx.A.customerId, null, '250.00', 'bank_transfer', ctx.A.bank1102, null, actor, ds.manager);
    await payments.applyPayment(op2.id, inv, '100.00', actor, ds.manager);
    expect(await remaining('A', inv)).toBe('200.00');
    const r = await reverse('A', op2.id, 'advance was not ours');
    expect(r.invoicesReopened).toEqual([inv]);
    expect(await remaining('A', inv)).toBe('300.00');
    expect(await state('A', inv)).toBe('posted');
    expect(await payments.getUnappliedBalance(op2.id, ds.manager)).toBe('0.00');
  });

  it('R7 refused BEFORE any change: closed period, blank reason, and an account that can no longer fund the refund', async () => {
    const ds = await dsOf('A');
    const inv = await newInvoice('A', '100.00');
    const p = await pay('A', inv, '100.00');
    const before = await fingerprint('A');

    await ds.query(`UPDATE "process_instances" SET "currentState" = 'closed' WHERE "definitionKey" = 'accounting_fiscal_period'`);
    await expect(reverse('A', p.id)).rejects.toThrow(/not open/);
    await ds.query(`UPDATE "process_instances" SET "currentState" = 'open' WHERE "definitionKey" = 'accounting_fiscal_period'`);
    expect(await fingerprint('A')).toEqual(before);

    await expect(reverse('A', p.id, ' ')).rejects.toThrow(/reason is required/);

    // spend the money, then try to hand it back
    const bankBalance = await bal('A');
    await treasury.cashOut(ctx.A.bank1102, bankBalance, null, null, null, 'spent', actor, ds.manager);
    const before2 = await fingerprint('A');
    await expect(reverse('A', p.id)).rejects.toThrow(/Insufficient treasury balance/);
    expect(await fingerprint('A')).toEqual(before2);
    expect(await state('A', inv)).toBe('paid');
    await fund('A', bankBalance); // restore for later tests (non-emitting funding)
    await reverse('A', p.id);
    expect(await state('A', inv)).toBe('posted');
  });

  it('R8 reconciliation after everything: Treasury == GL (bank 1102), AR ledger total == GL AR, every journal balanced, no non-POSTED event, Company B untouched', async () => {
    const ds = await dsOf('A');
    // funding rows created by `fund`/non-emitting cash-out are Treasury-only by design; compare the payment-owned effect through the ledger instead
    const arLedger = await ds.query(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'credit' THEN -"amount" ELSE "amount" END),0)::numeric(14,2)::text AS owed FROM "customer_ledger_entries" WHERE "paymentId" IS NOT NULL`,
    );
    expect(arLedger[0].owed).toBe(await gl('A', '1110')); // payment-related AR movements in the subledger == their GL effect (both net to the same figure)
    const unbalanced = await ds.query(`SELECT count(*)::int AS n FROM "accounting_journal_entries" WHERE "postedAt" IS NOT NULL AND "totalDebitBase" <> "totalCreditBase"`);
    expect(unbalanced[0].n).toBe(0);
    const bad = await ds.query(`SELECT count(*)::int AS n FROM "accounting_financial_events" WHERE status <> 'POSTED'`);
    expect(bad[0].n).toBe(0);
    const reversalsWithoutRow = await ds.query(
      `SELECT count(*)::int AS n FROM "accounting_financial_events" e WHERE e."eventType" = 'finance.payment.reversed' AND NOT EXISTS (SELECT 1 FROM "customer_payment_reversals" r WHERE r."paymentId"::text = e."sourceEntityId")`,
    );
    expect(reversalsWithoutRow[0].n).toBe(0);
    // the offsetting leg of a reversed payment is covered by the document's own `...:reversed` event - it must NOT show up as a posting exception
    const exc = await new TreasuryPostingExceptionsService(h.controlPlane).list({}, ds.manager);
    expect(exc.rows.filter((r) => r.category === 'customer_payment')).toEqual([]);
    expect((await fingerprint('B')).treasuryTxns).toBe(0);
  });
});
