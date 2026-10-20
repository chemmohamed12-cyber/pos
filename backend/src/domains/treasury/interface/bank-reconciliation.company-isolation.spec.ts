import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { TreasuryService } from '../application/treasury.service';
import { TreasuryDocumentService, TreasuryDocumentInput } from '../application/treasury-document.service';
import { BankStatementService, ImportStatementInput } from '../application/bank-statement.service';
import { CashSessionService } from '../application/cash-session.service';
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
 * T5 (2026-10-21) — bank statements, matching, reconciliation and cash custody sessions on real PostgreSQL, two Companies.
 * Proves: import validation and duplicate / ordering protection; the matcher only SUGGESTS (nothing is ever matched without a person); confirm checks account, status and the
 * to-the-cent sum; one movement ↔ one active bank match even under concurrency; a bank fee becomes an ordinary Treasury document and is then matched; reconciliation closes only
 * when adjusted bank == adjusted book and is reopened only with a reason; bank SETTLEMENT is a state separate from execution; cash sessions record the count, resolve a variance
 * through a draft document (profile reason, separate approver) and are immutable except by a controlled reopen.
 */
describe('T5 — bank reconciliation and cash sessions (real-Postgres, A/B)', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let docs: TreasuryDocumentService;
  let treasury: TreasuryService;
  let statements: BankStatementService;
  let sessions: CashSessionService;
  const cfg: Record<string, unknown> = {};
  const year = new Date().toISOString().slice(0, 4);
  let preparer: string;
  let approver: string;
  let executor: string;
  const acc = { cash: '', bank: '', bank2: '' };
  const dsOf = (k: 'A' | 'B') => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);
  const mgrA = async () => (await dsOf('A')).manager;
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const today = day(0);

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 't5_bank', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
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
    const events = new EventBusService(inert, h.connections);
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
    const dsA = await dsOf('A');
    await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") SELECT id, 'finance.cash_document.approve', 'editable' FROM roles WHERE key = 'admin' ON CONFLICT DO NOTHING`);
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const customers = new CustomersService(h.controlPlane, inert, inert, inert, inert, authorization, inert, inert);
    const customerLedger = new CustomerLedgerService(h.controlPlane, numbering, audit, customers);
    const invoices = new InvoiceService(h.controlPlane, numbering, processEngine, audit, inert, customers, customerLedger, events, inert);
    const payments = new PaymentsService(h.controlPlane, numbering, audit, treasury, customerLedger, invoices, events, customers);
    const approvals = new ApprovalEngineService(ambient, new ProcessEngineService(ambient), new AuditService(ambient), events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    docs = new TreasuryDocumentService(h.controlPlane, treasury, numbering, audit, events, approvals, config, payments);
    await docs.onModuleInit();
    statements = new BankStatementService(h.controlPlane, treasury, numbering, audit);
    sessions = new CashSessionService(h.controlPlane, treasury, docs, numbering, audit);

    for (const [code, name, type, normal, fn] of [
      ['1101', 'Cash', 'asset', 'debit', 'bank'], ['1102', 'Bank', 'asset', 'debit', 'bank'], ['1103', 'Bank 2', 'asset', 'debit', 'bank'], ['1110', 'AR', 'asset', 'debit', 'ar'],
      ['4900', 'Other income', 'revenue', 'credit', null], ['4901', 'Cash over', 'revenue', 'credit', null], ['5900', 'Misc expense', 'expense', 'debit', null],
      ['5901', 'Bank charges', 'expense', 'debit', null], ['5902', 'Cash short', 'expense', 'debit', null], ['3999', 'Clearing', 'asset', 'debit', null],
    ] as const) {
      await dsA.query(`INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`, [randomUUID(), code, name, type, normal, fn]);
    }
    const fy = randomUUID(); const fp = randomUUID();
    await dsA.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await dsA.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await dsA.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`, [randomUUID(), fy, randomUUID(), fp]);
    await new NumberingService(h.controlPlane).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, dsA.manager);
    const types = await treasury.listAccountTypes(dsA.manager);
    const mk = async (code: string, type: string, gl: string) => { const a = await treasury.createAccount(code, code, types.find((t) => t.code === type)!.id, preparer, dsA.manager); await treasury.setAccountGlMapping(a.id, gl, preparer, dsA.manager); return a.id; };
    acc.cash = await mk('T5CASH', 'cash', '1101');
    acc.bank = await mk('T5BANK', 'bank', '1102');
    acc.bank2 = await mk('T5BANK2', 'bank', '1103');
    cfg['accounting.treasury_receipt_reason_accounts'] = { OTHER_INCOME: '4900' };
    cfg['accounting.treasury_disbursement_reason_accounts'] = { MISC_EXPENSE: '5900', BANK_FEE: '5901' };
    cfg['accounting.cash_movement_clearing_account_code'] = '3999';
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('T5 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  async function fullFlow(input: TreasuryDocumentInput) {
    const m = await mgrA();
    const d = await docs.create(input, preparer, m);
    await docs.submit(d.id, undefined, preparer, m);
    await docs.decide(d.id, approver, 'approved', undefined, m);
    return docs.execute(d.id, undefined, executor, m);
  }
  async function count(sql: string): Promise<number> { return Number((await (await dsOf('A')).query(sql))[0].n); }
  const lineOf = async (statementId: string, ref: string) => {
    const s = await statements.get(statementId, await mgrA());
    return s.lines.find((l) => l.reference === ref)!;
  };
  const legOf = async (reference: string) => {
    const rows = await (await dsOf('A')).query(`SELECT id FROM treasury_transactions WHERE reference = $1 AND "treasuryAccountId" = $2 ORDER BY "createdAt" DESC LIMIT 1`, [reference, acc.bank]);
    return rows[0].id as string;
  };
  let stmt1 = '';

  it('R1 book movements are created through documents (receipt, deposit, disbursement) so the bank account carries +2000, +300, −120', async () => {
    await fullFlow({ kind: 'misc_receipt', treasuryAccountId: acc.bank, amount: '2000.00', reasonCode: 'OTHER_INCOME', reference: 'R-1', purpose: 'Customer wire' });
    await fullFlow({ kind: 'misc_receipt', treasuryAccountId: acc.cash, amount: '300.00', reasonCode: 'OTHER_INCOME', reference: 'CASH-IN', purpose: 'Takings' });
    await fullFlow({ kind: 'transfer', subtype: 'bank_deposit', treasuryAccountId: acc.cash, counterTreasuryAccountId: acc.bank, amount: '300.00', reference: 'DEP-1', purpose: 'Deposit takings' });
    await fullFlow({ kind: 'disbursement', treasuryAccountId: acc.bank, amount: '120.00', reasonCode: 'MISC_EXPENSE', reference: 'EXP-1', purpose: 'Supplies' });
    expect(await treasury.getAccountBalance(acc.bank, await mgrA())).toBe('2180.00');
  });

  it('R2 import validation: arithmetic, period, duplicates, chronology and continuity are enforced; nothing is stored on refusal', async () => {
    const m = await mgrA();
    const base: ImportStatementInput = {
      treasuryAccountId: acc.bank, statementNumber: 'OCT-1', periodStart: day(-3), periodEnd: today, openingBalance: '0.00', closingBalance: '2155.00',
      lines: [
        { valueDate: today, reference: 'R-1', description: 'Incoming wire R-1', amount: '2000.00' },
        { valueDate: today, reference: 'DEP-1', description: 'Cash deposit DEP-1', amount: '300.00' },
        { valueDate: today, reference: 'EXP-1', description: 'Payment EXP-1', amount: '-120.00' },
        { valueDate: today, reference: 'FEE-OCT', description: 'Monthly account fee', amount: '-25.00' },
      ],
    };
    const before = await count(`SELECT count(*) AS n FROM bank_statements`);
    await expect(statements.importStatement({ ...base, closingBalance: '2154.00' }, preparer, m)).rejects.toThrow(/does not add up/);
    await expect(statements.importStatement({ ...base, lines: [{ ...base.lines[0], valueDate: day(-30) }, ...base.lines.slice(1)] }, preparer, m)).rejects.toThrow(/outside the statement period/);
    await expect(statements.importStatement({ ...base, lines: [] }, preparer, m)).rejects.toThrow(/at least one line/);
    await expect(statements.importStatement({ ...base, lines: [{ ...base.lines[0], amount: '0.00' }, ...base.lines.slice(1)] }, preparer, m)).rejects.toThrow(/non-zero/);
    expect(await count(`SELECT count(*) AS n FROM bank_statements`)).toBe(before);

    const ok = await statements.importStatement(base, preparer, m);
    stmt1 = ok.id;
    expect(ok.systemNumber).toMatch(/^BST/);
    expect(ok.lineCount).toBe(4);
    await expect(statements.importStatement(base, preparer, m)).rejects.toThrow(/already imported as BST/); // same file again
    await expect(statements.importStatement({ ...base, statementNumber: 'OCT-1b', lines: [...base.lines.slice(0, 3), { ...base.lines[3], description: 'other text' }] }, preparer, m)).rejects.toThrow(/overlaps or precedes/);
    await expect(statements.importStatement({ ...base, periodStart: day(1), periodEnd: day(5), openingBalance: '9999.00', closingBalance: '9999.00', lines: [{ valueDate: day(1), amount: '1.00' }, { valueDate: day(2), amount: '-1.00' }] }, preparer, m)).rejects.toThrow(/does not continue from the closing balance 2155\.00/);
    expect(await count(`SELECT count(*) AS n FROM bank_statements`)).toBe(before + 1);
  });

  it('R3 the matcher only SUGGESTS: three lines get a strong suggestion, the bank fee has none, and not a single match exists until a person confirms', async () => {
    const m = await mgrA();
    const out = await statements.suggest(stmt1, preparer, m);
    expect(out).toEqual({ suggested: 3, ambiguous: 0, unmatched: 1 });
    expect(await count(`SELECT count(*) AS n FROM bank_statement_matches`)).toBe(0);
    const s = await statements.get(stmt1, m);
    expect(s.lines.filter((l) => l.status === 'matched')).toHaveLength(0);
    expect(s.lines.find((l) => l.reference === 'FEE-OCT')!.status).toBe('unmatched');
    expect(s.lines.find((l) => l.reference === 'R-1')!.suggestion!.candidates[0].reasons).toContain('reference');
  });

  it('R4 reconcile is refused while lines are unmatched; confirm checks the amount to the cent and the account; a matching amount is not enough without a person confirming', async () => {
    const m = await mgrA();
    await expect(statements.reconcile(stmt1, approver, m)).rejects.toThrow(/4 bank line\(s\) are not matched/);
    const wire = await lineOf(stmt1, 'R-1');
    const dep = await legOf('DEP-1');
    await expect(statements.confirm(wire.id, [dep], approver, m)).rejects.toThrow(/add up to 300\.00, but the bank line is 2000\.00/);
    const cashLeg = (await (await dsOf('A')).query(`SELECT id FROM treasury_transactions WHERE "treasuryAccountId" = $1 LIMIT 1`, [acc.cash]))[0].id;
    await expect(statements.confirm(wire.id, [cashLeg], approver, m)).rejects.toThrow(/another Treasury account/);
    await expect(statements.confirm(wire.id, [], approver, m)).rejects.toThrow(/at least one/);
    expect(await count(`SELECT count(*) AS n FROM bank_statement_matches`)).toBe(0);
    for (const ref of ['R-1', 'DEP-1', 'EXP-1']) {
      const l = await lineOf(stmt1, ref);
      const confirmed = await statements.confirm(l.id, [await legOf(ref)], approver, m);
      expect(confirmed.status).toBe('matched');
    }
    expect((await (await dsOf('A')).query(`SELECT method FROM bank_statement_matches`)).every((r: { method: string }) => r.method === 'suggestion_confirmed')).toBe(true);
    await expect(statements.reconcile(stmt1, approver, m)).rejects.toThrow(/1 bank line\(s\) are not matched \(-25\.00/);
  });

  it('R5 the bank fee is recorded through an ordinary Treasury document (posting profile), then matched; reconciliation closes only now, at difference 0.00', async () => {
    const m = await mgrA();
    const fee = await fullFlow({ kind: 'disbursement', treasuryAccountId: acc.bank, amount: '25.00', reasonCode: 'BANK_FEE', reference: 'FEE-OCT', purpose: 'Bank fee October' });
    expect(fee.settlement.state).toBe('unsettled'); // executed and posted, but the bank has not been shown to have cleared it
    await statements.suggest(stmt1, preparer, m);
    const feeLine = await lineOf(stmt1, 'FEE-OCT');
    expect(feeLine.status).toBe('suggested');
    await statements.confirm(feeLine.id, [fee.executedTransactionId!], approver, m);
    const view = await statements.reconciliation(stmt1, m);
    expect(view).toMatchObject({ closingBalance: '2155.00', bookBalanceAtPeriodEnd: '2155.00', outstandingBookNet: '0.00', bankOnlyNet: '0.00', difference: '0.00', reconciled: false });
    const done = await statements.reconcile(stmt1, approver, m);
    expect(done.status).toBe('reconciled');
    expect(done.reconciliationDifference).toBe('0.00');
    expect((await docs.get(fee.id, m)).settlement).toMatchObject({ state: 'matched', lineNumber: 4 });
    // the three earlier documents are matched too, and the GL for the fee is Dr bank charges / Cr bank — the statement itself posted nothing
    expect(Number((await (await dsOf('A')).query(`SELECT COALESCE(SUM(jl."debitBase"-jl."creditBase"),0)::numeric(20,2)::text AS b FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" JOIN accounting_journal_entries je ON je.id = jl."journalEntryId" AND je."postedAt" IS NOT NULL WHERE ga.code = '5901'`))[0].b)).toBe(25);
  });

  it('R6 a reconciled statement is protected: no unmatch, no re-matching; reopening needs a reason and makes the statement editable again, and the audit keeps the history', async () => {
    const m = await mgrA();
    const l = await lineOf(stmt1, 'EXP-1');
    await expect(statements.unmatch(l.id, 'oops', approver, m)).rejects.toThrow(/is reconciled/);
    await expect(statements.suggest(stmt1, approver, m)).rejects.toThrow(/reconciled statement cannot be re-matched/);
    await expect(statements.reopen(stmt1, '', approver, m)).rejects.toThrow(/reason is required/);
    await statements.reopen(stmt1, 'wrong statement version', approver, m);
    await expect(statements.unmatch(l.id, 'x', approver, m)).rejects.toThrow(/reason is required/);
    await statements.unmatch(l.id, 'matched to the wrong leg', approver, m);
    const view = await statements.reconciliation(stmt1, m);
    expect(view).toMatchObject({ bankOnlyNet: '-120.00', outstandingBookNet: '-120.00', difference: '0.00' }); // the arithmetic still balances: a bank item and an identical book item are both outstanding...
    await expect(statements.reconcile(stmt1, approver, m)).rejects.toThrow(/1 bank line\(s\) are not matched/); // ...but a line that is not matched can never be reconciled
    await statements.confirm(l.id, [await legOf('EXP-1')], approver, m);
    await statements.reconcile(stmt1, approver, m);
    const actions = (await (await dsOf('A')).query(`SELECT action FROM audit_records WHERE action LIKE 'treasury.bank_statement.%'`)).map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['treasury.bank_statement.imported', 'treasury.bank_statement.suggested', 'treasury.bank_statement.matched', 'treasury.bank_statement.reconciled', 'treasury.bank_statement.reopened', 'treasury.bank_statement.unmatched']));
  });

  it('R7 an outstanding item and an ambiguous match: a movement the bank has not shown is an outstanding item (aged), identical candidates are AMBIGUOUS, and one movement can never be matched twice even concurrently', async () => {
    const m = await mgrA();
    // book: a deposit in transit (+500 today) and two identical +15 receipts; bank statement 2 shows only the two +15 lines (same day)
    await fullFlow({ kind: 'misc_receipt', treasuryAccountId: acc.bank, amount: '500.00', reasonCode: 'OTHER_INCOME', reference: 'TRANSIT-1', purpose: 'in transit' });
    await fullFlow({ kind: 'misc_receipt', treasuryAccountId: acc.bank, amount: '15.00', reasonCode: 'OTHER_INCOME', reference: 'P-A', purpose: 'small a' });
    await fullFlow({ kind: 'misc_receipt', treasuryAccountId: acc.bank, amount: '15.00', reasonCode: 'OTHER_INCOME', reference: 'P-B', purpose: 'small b' });
    const s2 = await statements.importStatement(
      { treasuryAccountId: acc.bank, statementNumber: 'OCT-2', periodStart: day(1), periodEnd: day(1), openingBalance: '2155.00', closingBalance: '2185.00', lines: [{ valueDate: day(1), amount: '15.00', description: 'credit' }, { valueDate: day(1), amount: '15.00', description: 'credit 2' }] },
      preparer, m,
    );
    // legs are dated today; statement 2 is dated tomorrow → within the 5-day window, same amount, no reference → two identical candidates per line
    const out = await statements.suggest(s2.id, preparer, m);
    expect(out).toEqual({ suggested: 0, ambiguous: 2, unmatched: 0 });
    const lines = (await statements.get(s2.id, m)).lines;
    expect(lines[0].suggestion!.candidates.map((c) => c.score)).toEqual([55, 55]);
    const legA = await legOf('P-A');
    const results = await Promise.allSettled([statements.confirm(lines[0].id, [legA], approver, m), statements.confirm(lines[1].id, [legA], approver, m)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await count(`SELECT count(*) AS n FROM bank_statement_matches WHERE "treasuryTransactionId" = '${legA}' AND "unmatchedAt" IS NULL`)).toBe(1);
    const view = await statements.reconciliation(s2.id, m);
    expect(view.outstandingBookItems.map((i) => i.reference)).toEqual(expect.arrayContaining(['TRANSIT-1', 'P-B']));
    expect(view.unmatchedLines).toHaveLength(1);
    await expect(statements.reconcile(s2.id, approver, m)).rejects.toThrow(/1 bank line\(s\) are not matched/);
  });

  it('R8 Company B has no statements and cannot reach Company A\'s statement or session', async () => {
    const mB = (await dsOf('B')).manager;
    expect(await statements.list({}, mB)).toEqual([]);
    await expect(statements.get(stmt1, mB)).rejects.toThrow(/not found/);
    expect(await sessions.list({}, mB)).toEqual([]);
  });

  // ---------------------------------------------------------------- cash sessions
  let sess1 = '';
  it('S1 a cash session opens only on a cash/custody account, one open session per account; closing with an exact count needs no variance document and is immutable afterwards', async () => {
    const m = await mgrA();
    await expect(sessions.open({ treasuryAccountId: acc.bank }, preparer, m)).rejects.toThrow(/cash or custody account/);
    const s = await sessions.open({ treasuryAccountId: acc.cash, note: 'morning shift' }, preparer, m);
    sess1 = s.id;
    expect(s.sessionNumber).toMatch(/^CS/);
    expect(s.openingBalance).toBe(await treasury.getAccountBalance(acc.cash, m));
    await expect(sessions.open({ treasuryAccountId: acc.cash }, preparer, m)).rejects.toThrow(/already has an open session/);
    const expected = await treasury.getAccountBalance(acc.cash, m);
    const closed = await sessions.close(sess1, { countedAmount: expected }, preparer, m);
    expect(closed).toMatchObject({ status: 'closed', variance: '0.00', varianceDocumentId: null });
    await expect(sessions.close(sess1, { countedAmount: expected }, preparer, m)).rejects.toThrow(/already closed/);
  });

  it('S2 a SHORT count: refused without a reason and while the profile has no CASH_SHORT; with both, the session closes and a DRAFT disbursement resolves it through a separate approver; nothing moves until executed', async () => {
    const m = await mgrA();
    await fullFlow({ kind: 'misc_receipt', treasuryAccountId: acc.cash, amount: '100.00', reasonCode: 'OTHER_INCOME', reference: 'DRAWER-1', purpose: 'Drawer float' });
    const s = await sessions.open({ treasuryAccountId: acc.cash }, preparer, m);
    const expected = Number(await treasury.getAccountBalance(acc.cash, m));
    const counted = (expected - 40).toFixed(2);
    await expect(sessions.close(s.id, { countedAmount: counted }, preparer, m)).rejects.toThrow(/reason for the variance is required/);
    await expect(sessions.close(s.id, { countedAmount: counted, varianceReason: 'till error' }, preparer, m)).rejects.toThrow(/"CASH_SHORT" is not mapped/);
    expect((await sessions.get(s.id, m)).status).toBe('open'); // refused = nothing closed
    cfg['accounting.treasury_disbursement_reason_accounts'] = { MISC_EXPENSE: '5900', BANK_FEE: '5901', CASH_SHORT: '5902' };
    const before = await treasury.getAccountBalance(acc.cash, m);
    const closed = await sessions.close(s.id, { countedAmount: counted, varianceReason: 'till error' }, preparer, m);
    expect(closed).toMatchObject({ status: 'closed', variance: '-40.00' });
    expect(await treasury.getAccountBalance(acc.cash, m)).toBe(before); // recording the variance moved no money
    const doc = await docs.get(closed.varianceDocumentId!, m);
    expect(doc).toMatchObject({ kind: 'disbursement', status: 'draft', amount: '40.00', reasonCode: 'CASH_SHORT', reference: closed.sessionNumber });
    await docs.submit(doc.id, undefined, preparer, m);
    await expect(docs.decide(doc.id, preparer, 'approved', undefined, m)).rejects.toThrow(/maker/); // the closer cannot approve their own correction
    await docs.decide(doc.id, approver, 'approved', undefined, m);
    await docs.execute(doc.id, undefined, executor, m);
    expect(await treasury.getAccountBalance(acc.cash, m)).toBe(counted); // the ledger now equals the count
    await expect(sessions.reopen(s.id, 'recount', approver, m)).rejects.toThrow(/approved and executed|"executed"/);
  });

  it('S3 an OVER count resolves through a receipt draft; reopening a session whose correction is still a draft cancels that draft; concurrent closes close it once', async () => {
    const m = await mgrA();
    cfg['accounting.treasury_receipt_reason_accounts'] = { OTHER_INCOME: '4900', CASH_OVER: '4901' };
    const s = await sessions.open({ treasuryAccountId: acc.cash }, preparer, m);
    const expected = Number(await treasury.getAccountBalance(acc.cash, m));
    const counted = (expected + 12.5).toFixed(2);
    const results = await Promise.allSettled([sessions.close(s.id, { countedAmount: counted, varianceReason: 'found cash' }, preparer, m), sessions.close(s.id, { countedAmount: counted, varianceReason: 'found cash' }, preparer, m)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const closed = await sessions.get(s.id, m);
    expect(closed.variance).toBe('12.50');
    const doc = await docs.get(closed.varianceDocumentId!, m);
    expect(doc).toMatchObject({ kind: 'misc_receipt', reasonCode: 'CASH_OVER', amount: '12.50', status: 'draft' });
    expect(await count(`SELECT count(*) AS n FROM treasury_documents WHERE reference = '${closed.sessionNumber}'`)).toBe(1); // exactly one variance document
    await expect(sessions.reopen(s.id, '', preparer, m)).rejects.toThrow(/reason is required/);
    const reopened = await sessions.reopen(s.id, 'recount the drawer', preparer, m);
    expect(reopened).toMatchObject({ status: 'open', variance: null, varianceDocumentId: null, reopenReason: 'recount the drawer' });
    expect((await docs.get(doc.id, m)).status).toBe('cancelled');
    expect(await count(`SELECT count(*) AS n FROM audit_records WHERE action = 'treasury.cash_session.reopened'`)).toBe(1);
  });
});
