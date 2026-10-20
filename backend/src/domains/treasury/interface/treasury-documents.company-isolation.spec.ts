import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { TreasuryService } from '../application/treasury.service';
import { TreasuryDocumentService, TreasuryDocumentInput } from '../application/treasury-document.service';
import { PaymentsService } from '../../customer-finance/application/payments.service';
import { CustomersService } from '../../crm/application/customers.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { InvoiceService } from '../../customer-finance/application/invoices.service';
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
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { ApprovalRequestType } from '../../../foundation/approval-engine/approval-request-type.entity';
import { ApprovalMatrixRule } from '../../../foundation/approval-engine/approval-matrix-rule.entity';
import { ApprovalRequest } from '../../../foundation/approval-engine/approval-request.entity';
import { ApprovalDecision } from '../../../foundation/approval-engine/approval-decision.entity';
import { ProcessInstance } from '../../../foundation/process-engine/process-instance.entity';
import { ProcessTransitionRecord } from '../../../foundation/process-engine/process-transition-record.entity';
import { AuditRecord } from '../../../foundation/audit/audit-record.entity';
import { EventOutbox } from '../../../foundation/events/event-outbox.entity';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * T3 (2026-10-20) — Treasury Documents, real PostgreSQL, two Companies. The full lifecycle (prepare → submit → separate approver → explicit execute → reverse), multi-invoice
 * collection with an unapplied remainder, the three transfer purposes, posting-profile receipts / disbursements (no account typed by the user), separation of duties,
 * optimistic concurrency, idempotent / concurrent execution, closed-period atomicity, ownership of the legs, and Treasury == GL == AR at the end.
 */
describe('T3 — Treasury Documents (real-Postgres, A/B)', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let docs: TreasuryDocumentService;
  let treasury: TreasuryService;
  let invoices: InvoiceService;
  let payments: PaymentsService;
  let events: EventBusService;
  const cfg: Record<string, unknown> = {};
  const year = new Date().toISOString().slice(0, 4);
  let preparer: string;
  let approver: string;
  let executor: string;
  let other: string;
  type Key = 'A' | 'B';
  const acc: Record<Key, { cash: string; bank: string; bank2: string; customerId: string }> = { A: { cash: '', bank: '', bank2: '', customerId: '' }, B: { cash: '', bank: '', bank2: '', customerId: '' } };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);
  const mgr = async (k: Key) => (await dsOf(k)).manager;

  async function seed(k: Key) {
    const ds = await dsOf(k);
    for (const [code, name, type, normal, fn] of [
      ['1101', 'Cash on Hand', 'asset', 'debit', 'bank'],
      ['1102', 'Bank', 'asset', 'debit', 'bank'],
      ['1103', 'Bank 2', 'asset', 'debit', 'bank'],
      ['1110', 'Accounts Receivable', 'asset', 'debit', 'ar'],
      ['4900', 'Other income', 'revenue', 'credit', null],
      ['5900', 'Misc expense', 'expense', 'debit', null],
      ['3999', 'Cash clearing', 'asset', 'debit', null],
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
    const types = await treasury.listAccountTypes(ds.manager);
    const mk = async (code: string, type: string, gl: string) => {
      const a = await treasury.createAccount(`${code}-${k}`, `${code} ${k}`, types.find((t) => t.code === type)!.id, preparer, ds.manager);
      await treasury.setAccountGlMapping(a.id, gl, preparer, ds.manager);
      return a.id;
    };
    acc[k].cash = await mk('CASH', 'cash', '1101');
    acc[k].bank = await mk('BANK', 'bank', '1102');
    acc[k].bank2 = await mk('BANK2', 'bank', '1103');
    const customerId = randomUUID();
    await ds.query(`INSERT INTO "customers" ("id","code","name","creditLimit") VALUES ($1,$2,'T3 Customer','100000.00')`, [customerId, `T3-CUST-${k}`]);
    acc[k].customerId = customerId;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 't3_documents', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    const opts = h.controlPlane.options as { host: string; port: number; username: string; password: string; database: string };
    ambient = new DataSource({
      type: 'postgres', host: opts.host, port: opts.port, username: opts.username, password: opts.password, database: opts.database,
      entities: [ApprovalRequestType, ApprovalMatrixRule, ApprovalRequest, ApprovalDecision, ProcessInstance, ProcessTransitionRecord, AuditRecord, EventOutbox],
      synchronize: false, logging: false,
    });
    await ambient.initialize();
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    events = new EventBusService(inert, h.connections);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const config = { get: (key: string) => cfg[key] } as unknown as ConfigurationEngineService;
    const currencies = new CurrencyService(h.controlPlane, audit);
    const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
    new FinancialEventService(h.controlPlane, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), config).onModuleInit();
    treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);

    preparer = (await h.createUserWithAdminRoleIn('Preparer', h.companyAId)).id;
    approver = (await h.createUserWithAdminRoleIn('Approver', h.companyAId)).id;
    executor = (await h.createUserWithAdminRoleIn('Executor', h.companyAId)).id;
    other = (await h.createUserWithAdminRoleIn('Other', h.companyAId)).id;
    await (await dsOf('A')).query(`INSERT INTO role_permissions ("roleId","nodeKey","access") SELECT id, 'finance.cash_document.approve', 'editable' FROM roles WHERE key = 'admin' ON CONFLICT DO NOTHING`);

    const dsA = await dsOf('A');
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const customers = new CustomersService(h.controlPlane, inert, inert, inert, inert, authorization, inert, inert);
    const customerLedger = new CustomerLedgerService(h.controlPlane, numbering, audit, customers);
    invoices = new InvoiceService(h.controlPlane, numbering, processEngine, audit, inert, customers, customerLedger, events, inert);
    payments = new PaymentsService(h.controlPlane, numbering, audit, treasury, customerLedger, invoices, events, customers);

    const approvals = new ApprovalEngineService(ambient, new ProcessEngineService(ambient), new AuditService(ambient), events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    docs = new TreasuryDocumentService(h.controlPlane, treasury, numbering, audit, events, approvals, config, payments);
    await docs.onModuleInit();

    await seed('A');
    await seed('B');
    cfg['accounting.treasury_receipt_reason_accounts'] = { OTHER_INCOME: '4900', BAD_CONTROL: '1110' };
    cfg['accounting.treasury_disbursement_reason_accounts'] = { MISC_EXPENSE: '5900' };
    cfg['accounting.cash_movement_clearing_account_code'] = '3999';
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('T3 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---- helpers
  async function newInvoice(k: Key, total: string): Promise<string> {
    const ds = await dsOf(k);
    const id = randomUUID();
    await ds.query(`INSERT INTO "sales_invoices" ("id","invoiceNumber","customerId","salesOrderId","subtotal","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,$5,$5,$6)`, [id, `T3-INV-${k}-${id.slice(0, 8)}`, acc[k].customerId, randomUUID(), total, preparer]);
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'sales_invoice_lifecycle','sales_invoice',$2,'posted')`, [randomUUID(), id]);
    return id;
  }
  async function glBal(k: Key, code: string): Promise<string> {
    const r = await (await dsOf(k)).query(
      `SELECT COALESCE(SUM(jl."debitBase" - jl."creditBase"),0)::numeric(20,2)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" JOIN "accounting_journal_entries" je ON je.id = jl."journalEntryId" AND je."postedAt" IS NOT NULL WHERE ga.code = $1`,
      [code],
    );
    return r[0].b;
  }
  const bal = async (k: Key, accountId: string) => treasury.getAccountBalance(accountId, await mgr(k));
  async function fingerprint(k: Key) {
    const ds = await dsOf(k);
    const n = async (sql: string) => Number((await ds.query(sql))[0].n);
    return {
      treasuryTxns: await n(`SELECT count(*) AS n FROM "treasury_transactions"`),
      payments: await n(`SELECT count(*) AS n FROM "customer_payments"`),
      ledger: await n(`SELECT count(*) AS n FROM "customer_ledger_entries"`),
      events: await n(`SELECT count(*) AS n FROM "accounting_financial_events"`),
      journals: await n(`SELECT count(*) AS n FROM "accounting_journal_entries"`),
    };
  }
  const approve = async (id: string) => docs.decide(id, approver, 'approved', undefined, await mgr('A'));
  /** prepare → submit → separate approver → explicit execute, by three different people. */
  async function fullFlow(input: TreasuryDocumentInput) {
    const m = await mgr('A');
    const d = await docs.create(input, preparer, m);
    await docs.submit(d.id, undefined, preparer, m);
    await approve(d.id);
    return docs.execute(d.id, undefined, executor, m);
  }
  const setPeriod = async (state: 'open' | 'closed') => (await dsOf('A')).query(`UPDATE "process_instances" SET "currentState" = $1 WHERE "definitionKey" = 'accounting_fiscal_period'`, [state]);

  // ---- tests
  it('D1 funding by a miscellaneous-receipt document uses the company posting profile (revenue account chosen by the profile, never by the user) and keeps Treasury == GL', async () => {
    const d = await fullFlow({ kind: 'misc_receipt', treasuryAccountId: acc.A.cash, amount: '2000.00', reasonCode: 'OTHER_INCOME', reference: 'FUND-1', purpose: 'Opening cash top-up' });
    expect(d.status).toBe('executed');
    expect(d.approvedByUserId).toBe(approver);
    expect(d.executedByUserId).toBe(executor);
    expect(d.createdByUserId).toBe(preparer);
    expect(await bal('A', acc.A.cash)).toBe('2000.00');
    expect(await glBal('A', '1101')).toBe('2000.00');
    expect(await glBal('A', '4900')).toBe('-2000.00');
    expect(await glBal('A', '3999')).toBe('0.00'); // NOT parked in the clearing account
    const effect = await docs.previewEffect(d.id, await mgr('A'));
    expect(effect.lines.map((l) => `${l.side}:${l.glAccountCode}`)).toEqual(['debit:1101', 'credit:4900']);
  });

  it('D2 multi-invoice collection with an unapplied remainder: one receipt, one Treasury leg, one GL event; each invoice settled in its own ledger; reversal restores everything', async () => {
    const i1 = await newInvoice('A', '500.00');
    const i2 = await newInvoice('A', '400.00');
    const m = await mgr('A');
    const before = await fingerprint('A');
    const d = await fullFlow({ kind: 'customer_collection', treasuryAccountId: acc.A.bank, customerId: acc.A.customerId, method: 'bank_transfer', reference: 'CHQ-77', purpose: 'Settlement', allocations: [{ invoiceId: i1, amount: '300.00' }, { invoiceId: i2, amount: '400.00' }], unappliedAmount: '50.00' });
    expect(d.status).toBe('executed');
    expect(d.amount).toBe('750.00');
    const after = await fingerprint('A');
    expect(after.treasuryTxns - before.treasuryTxns).toBe(1);
    expect(after.payments - before.payments).toBe(1);
    expect(after.events - before.events).toBe(1);
    expect(after.journals - before.journals).toBe(1);
    expect(after.ledger - before.ledger).toBe(3); // two invoices + the unapplied credit
    expect(await invoices.getInvoiceRemaining(i1, m)).toBe('200.00');
    expect(await invoices.getStatus(i1, m)).toBe('partially_paid');
    expect(await invoices.getInvoiceRemaining(i2, m)).toBe('0.00');
    expect(await invoices.getStatus(i2, m)).toBe('paid');
    expect(await payments.getUnappliedBalance(d.executedPaymentId!, m)).toBe('50.00');
    expect(await bal('A', acc.A.bank)).toBe('750.00');
    expect(await glBal('A', '1102')).toBe('750.00');
    expect(await glBal('A', '1110')).toBe('-750.00');

    const rev = await docs.reverse(d.id, 'wrong customer', other, m);
    expect(rev.status).toBe('reversed');
    expect(await invoices.getInvoiceRemaining(i1, m)).toBe('500.00');
    expect(await invoices.getStatus(i1, m)).toBe('posted');
    expect(await invoices.getStatus(i2, m)).toBe('posted');
    expect(await payments.getUnappliedBalance(d.executedPaymentId!, m)).toBe('0.00');
    expect(await bal('A', acc.A.bank)).toBe('0.00');
    expect(await glBal('A', '1102')).toBe('0.00');
    expect(await glBal('A', '1110')).toBe('0.00');
  });

  it('D3 allocation controls: over-allocation, duplicate invoice, another Company\'s invoice and a missing allocation are all refused with nothing recorded', async () => {
    const m = await mgr('A');
    const inv = await newInvoice('A', '100.00');
    const foreign = await newInvoice('B', '100.00');
    const base = { kind: 'customer_collection' as const, treasuryAccountId: acc.A.bank, customerId: acc.A.customerId, method: 'cash', purpose: 'purpose' };
    await expect(docs.create({ ...base, allocations: [{ invoiceId: inv, amount: '10.00' }, { invoiceId: inv, amount: '5.00' }] }, preparer, m)).rejects.toThrow(/only once/);
    await expect(docs.create({ ...base, allocations: [] }, preparer, m)).rejects.toThrow(/at least one allocation/);
    const over = await docs.create({ ...base, allocations: [{ invoiceId: inv, amount: '150.00' }] }, preparer, m);
    await expect(docs.submit(over.id, undefined, preparer, m)).rejects.toThrow(/only 100.00 remaining|remaining/);
    const foreignDoc = await docs.create({ ...base, allocations: [{ invoiceId: foreign, amount: '10.00' }] }, preparer, m);
    await expect(docs.submit(foreignDoc.id, undefined, preparer, m)).rejects.toThrow(/no longer open/);
    expect((await docs.get(over.id, m)).status).toBe('draft');
    expect((await docs.get(foreignDoc.id, m)).status).toBe('draft');
  });

  it('D4 transfers: account transfer, bank deposit (cash→bank) and bank withdrawal (bank→cash) post Dr destination / Cr source; a wrong-direction deposit is refused; reversal restores', async () => {
    const m = await mgr('A');
    const t1 = await fullFlow({ kind: 'transfer', subtype: 'bank_deposit', treasuryAccountId: acc.A.cash, counterTreasuryAccountId: acc.A.bank, amount: '500.00', purpose: 'Deposit takings', reference: 'DEP-1' });
    expect(await bal('A', acc.A.cash)).toBe('1500.00');
    expect(await bal('A', acc.A.bank)).toBe('500.00');
    expect(await glBal('A', '1102')).toBe('500.00');
    await expect(docs.create({ kind: 'transfer', subtype: 'bank_deposit', treasuryAccountId: acc.A.bank, counterTreasuryAccountId: acc.A.cash, amount: '10.00', purpose: 'wrong way' }, preparer, m)).rejects.toThrow(/from a cash \/ custody account into a bank account/);
    await fullFlow({ kind: 'transfer', subtype: 'bank_withdrawal', treasuryAccountId: acc.A.bank, counterTreasuryAccountId: acc.A.cash, amount: '100.00', purpose: 'Petty cash', reference: 'WD-1' });
    const t3 = await fullFlow({ kind: 'transfer', subtype: 'account_transfer', treasuryAccountId: acc.A.bank, counterTreasuryAccountId: acc.A.bank2, amount: '150.00', purpose: 'Between banks', reference: 'TR-1' });
    expect(await bal('A', acc.A.bank)).toBe('250.00');
    expect(await bal('A', acc.A.bank2)).toBe('150.00');
    expect(await glBal('A', '1103')).toBe('150.00');
    const pnl = await (await dsOf('A')).query(
      `SELECT count(*)::int AS n FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" JOIN "accounting_journal_entries" je ON je.id = jl."journalEntryId" WHERE je."description" LIKE 'Treasury transfer%' AND ga."accountType" IN ('revenue','expense')`,
    );
    expect(pnl[0].n).toBe(0); // a transfer never touches income or expense
    await docs.reverse(t3.id, 'wrong bank', other, m);
    expect(await bal('A', acc.A.bank)).toBe('400.00');
    expect(await bal('A', acc.A.bank2)).toBe('0.00');
    expect(await glBal('A', '1102')).toBe('400.00');
    expect(await glBal('A', '1103')).toBe('0.00');
    expect(t1.status).toBe('executed');
  });

  it('D5 disbursement: counter account from the posting profile; an unmapped reason is refused at preparation; a reason removed from the profile later blocks execution with the document left approved', async () => {
    const m = await mgr('A');
    const d = await fullFlow({ kind: 'disbursement', treasuryAccountId: acc.A.cash, amount: '120.00', reasonCode: 'MISC_EXPENSE', reference: 'EXP-9', purpose: 'Office supplies' });
    expect(await glBal('A', '5900')).toBe('120.00');
    await expect(docs.create({ kind: 'disbursement', treasuryAccountId: acc.A.cash, amount: '5.00', reasonCode: 'NOT_MAPPED', reference: 'r', purpose: 'purpose' }, preparer, m)).rejects.toThrow(/no account in the company posting profile/);
    // a reason mapped to a CONTROL account is not usable: refused before commit by the posting guard
    const bad = await docs.create({ kind: 'misc_receipt', treasuryAccountId: acc.A.cash, amount: '5.00', reasonCode: 'BAD_CONTROL', reference: 'r', purpose: 'purpose' }, preparer, m);
    await docs.submit(bad.id, undefined, preparer, m);
    await approve(bad.id);
    const before = await fingerprint('A');
    await expect(docs.execute(bad.id, undefined, executor, m)).rejects.toThrow(/cannot be posted to the general ledger/);
    expect(await fingerprint('A')).toEqual(before);
    expect((await docs.get(bad.id, m)).status).toBe('approved');

    const later = await docs.create({ kind: 'disbursement', treasuryAccountId: acc.A.cash, amount: '7.00', reasonCode: 'MISC_EXPENSE', reference: 'r2', purpose: 'purpose' }, preparer, m);
    await docs.submit(later.id, undefined, preparer, m);
    await approve(later.id);
    const saved = cfg['accounting.treasury_disbursement_reason_accounts'];
    cfg['accounting.treasury_disbursement_reason_accounts'] = {};
    await expect(docs.execute(later.id, undefined, executor, m)).rejects.toThrow(/no longer mapped/);
    cfg['accounting.treasury_disbursement_reason_accounts'] = saved;
    expect((await docs.get(later.id, m)).status).toBe('approved');
    expect(d.status).toBe('executed');
  });

  it('D6 separation of duties and state machine: self-approval refused, execute before approval refused, only the preparer edits / submits / withdraws, stale version refused, rejected stays rejected', async () => {
    const m = await mgr('A');
    const input: TreasuryDocumentInput = { kind: 'misc_receipt', treasuryAccountId: acc.A.cash, amount: '30.00', reasonCode: 'OTHER_INCOME', reference: 'SOD-1', purpose: 'SoD test' };
    const d = await docs.create(input, preparer, m);
    await expect(docs.execute(d.id, undefined, executor, m)).rejects.toThrow(/Only an approved document/);
    await expect(docs.update(d.id, { ...input, amount: '31.00' }, d.version, other, m)).rejects.toThrow(/Only the preparer/);
    await expect(docs.submit(d.id, undefined, other, m)).rejects.toThrow(/Only the preparer/);
    await expect(docs.submit(d.id, d.version + 5, preparer, m)).rejects.toThrow(/changed since you opened it/);
    const updated = await docs.update(d.id, { ...input, amount: '32.00' }, d.version, preparer, m);
    expect(updated.amount).toBe('32.00');
    expect(updated.version).toBe(d.version + 1);
    await expect(docs.update(d.id, { ...input, amount: '33.00' }, d.version, preparer, m)).rejects.toThrow(/changed since you opened it/); // stale
    const sub = await docs.submit(d.id, updated.version, preparer, m);
    expect(sub.status).toBe('submitted');
    expect(sub.approvalRequestId).toBeTruthy();
    await expect(docs.decide(d.id, preparer, 'approved', undefined, m)).rejects.toThrow(/maker of an approval request cannot approve/);
    await expect(docs.cancel(d.id, 'not mine', other, m)).rejects.toThrow(/Only the preparer/);
    await docs.decide(d.id, approver, 'rejected', 'amount unclear', m);
    const rejected = await docs.get(d.id, m);
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionNote).toBe('amount unclear');
    await expect(docs.execute(d.id, undefined, executor, m)).rejects.toThrow(/Only an approved document/);
    const c = await docs.create(input, preparer, m);
    await docs.submit(c.id, undefined, preparer, m);
    expect((await docs.cancel(c.id, 'withdrawn', preparer, m)).status).toBe('cancelled'); // the preparer may withdraw while pending
  });

  it('D7 auto-approval only below an owner-set limit: with no limit every document needs a separate approver; at/below the limit it is approved without a request', async () => {
    const m = await mgr('A');
    const input: TreasuryDocumentInput = { kind: 'misc_receipt', treasuryAccountId: acc.A.cash, amount: '80.00', reasonCode: 'OTHER_INCOME', reference: 'AUTO-1', purpose: 'purpose' };
    const a = await docs.create(input, preparer, m);
    expect((await docs.submit(a.id, undefined, preparer, m)).status).toBe('submitted'); // no limit configured → fail-closed
    cfg['finance.treasury_document_auto_approve_limit'] = '100';
    const b = await docs.create(input, preparer, m);
    const sb = await docs.submit(b.id, undefined, preparer, m);
    expect(sb.status).toBe('approved');
    expect(sb.autoApproved).toBe(true);
    expect(sb.approvalRequestId).toBeNull();
    const c = await docs.create({ ...input, amount: '150.00' }, preparer, m);
    expect((await docs.submit(c.id, undefined, preparer, m)).status).toBe('submitted'); // above the limit
    delete cfg['finance.treasury_document_auto_approve_limit'];
  });

  it('D8 execution is atomic and exactly-once: a closed period leaves the document approved and nothing moved; 5 concurrent executes → one movement; a repeat execute changes nothing', async () => {
    const m = await mgr('A');
    const d = await docs.create({ kind: 'misc_receipt', treasuryAccountId: acc.A.cash, amount: '45.00', reasonCode: 'OTHER_INCOME', reference: 'ATOM-1', purpose: 'purpose' }, preparer, m);
    await docs.submit(d.id, undefined, preparer, m);
    await approve(d.id);
    await setPeriod('closed');
    const before = await fingerprint('A');
    await expect(docs.execute(d.id, undefined, executor, m)).rejects.toThrow(/not open/);
    expect(await fingerprint('A')).toEqual(before);
    expect((await docs.get(d.id, m)).status).toBe('approved');
    await setPeriod('open');

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => docs.execute(d.id, undefined, executor, m)));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    const after = await fingerprint('A');
    expect(after.treasuryTxns - before.treasuryTxns).toBe(1);
    expect(after.journals - before.journals).toBe(1);
    await docs.execute(d.id, undefined, executor, m);
    expect((await fingerprint('A')).treasuryTxns).toBe(after.treasuryTxns);
    expect((await docs.get(d.id, m)).status).toBe('executed');
  });

  it('D9 an executed document owns its Treasury leg: the raw Treasury reversal is refused, the document reversal is the only way; a back-dated document is refused', async () => {
    const m = await mgr('A');
    const d = await fullFlow({ kind: 'transfer', subtype: 'account_transfer', treasuryAccountId: acc.A.cash, counterTreasuryAccountId: acc.A.bank, amount: '20.00', purpose: 'owned leg', reference: 'OWN-1' });
    await expect(treasury.reverseTransaction(d.executedTransactionId!, 'raw', executor, m)).rejects.toThrow(/belongs to treasury document TD/);
    const m2 = await docs.create({ kind: 'misc_receipt', treasuryAccountId: acc.A.cash, amount: '12.00', reasonCode: 'OTHER_INCOME', reference: 'OWN-2', purpose: 'purpose', businessDate: '2020-01-01' }, preparer, m);
    await docs.submit(m2.id, undefined, preparer, m);
    await approve(m2.id);
    await expect(docs.execute(m2.id, undefined, executor, m)).rejects.toThrow(/back- or forward-dated/);
    const rev = await docs.reverse(d.id, 'cleanup', other, m);
    expect(rev.status).toBe('reversed');
    await expect(docs.reverse(d.id, 'again', other, m)).resolves.toMatchObject({ status: 'reversed' }); // idempotent, no second effect
  });

  it('D10 reversal of a misc receipt posts the offset against the SAME profile account (never the clearing account); then Treasury == GL, journals balance, no REJECTED event; Company B untouched', async () => {
    const m = await mgr('A');
    const d = await fullFlow({ kind: 'misc_receipt', treasuryAccountId: acc.A.bank2, amount: '60.00', reasonCode: 'OTHER_INCOME', reference: 'REV-1', purpose: 'purpose' });
    const incomeBefore = await glBal('A', '4900');
    await docs.reverse(d.id, 'duplicate', other, m);
    expect(Number(await glBal('A', '4900'))).toBe(Number(incomeBefore) + 60); // the credit to income was undone on the same account
    expect(await glBal('A', '3999')).toBe('0.00');
    const ds = await dsOf('A');
    for (const [accountId, code] of [[acc.A.cash, '1101'], [acc.A.bank, '1102'], [acc.A.bank2, '1103']] as const) expect(await bal('A', accountId)).toBe(await glBal('A', code));
    expect((await ds.query(`SELECT count(*)::int AS n FROM accounting_journal_entries WHERE "postedAt" IS NOT NULL AND "totalDebitBase" <> "totalCreditBase"`))[0].n).toBe(0);
    expect((await ds.query(`SELECT count(*)::int AS n FROM accounting_financial_events WHERE status <> 'POSTED'`))[0].n).toBe(0);
    const arLedger = await ds.query(`SELECT COALESCE(SUM(CASE WHEN "direction" = 'credit' THEN -"amount" ELSE "amount" END),0)::numeric(14,2)::text AS owed FROM "customer_ledger_entries" WHERE "paymentId" IS NOT NULL`);
    expect(arLedger[0].owed).toBe(await glBal('A', '1110'));
    const b = await fingerprint('B');
    expect(b).toEqual({ treasuryTxns: 0, payments: 0, ledger: 0, events: 0, journals: 0 });
    expect((await (await dsOf('B')).query(`SELECT count(*)::int AS n FROM treasury_documents`))[0].n).toBe(0);
  });
});
