import { randomUUID } from 'crypto';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { LedgerService } from '../application/ledger.service';
import { GLAccountService } from '../application/gl-account.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * CR-2026-10-15 — Trial Balance footer reconciliation, real Postgres.
 *
 * Company A posts (all POSTED):
 *   J1  Dr 1000 Cash      100 / Cr 4000 Revenue  100   (moved to 15 January — manual journals cannot be backdated)
 *   J2  Dr 5000 Expense    40 / Cr 1000 Cash      40
 *   J3  Dr 1999 Suspense   25 / Cr 1000 Cash      25
 *   J4  Dr 1000 Cash       25 / Cr 1999 Suspense  25
 *   J5  Dr 2000 Payable    10 / Cr 1000 Cash      10   (credit-normal account with a DEBIT balance)
 *   J6  Dr 1000 Cash       30 / Cr 2000 Payable   30   → Payable nets 20 Cr
 * Net per account: Cash 100-40-25+25-10+30 = 80 Dr · Revenue 100 Cr · Expense 40 Dr · Suspense 0 (omitted) · Payable 20 Cr.
 * Displayed rows: Dr 80 + 40 = 120, Cr 100 + 20 = 120.
 * Gross activity (the pre-existing `totalDebitBase`/`totalCreditBase`): 100+40+25+25+10+30 = 230 each side.
 * Before the fix the screen's footer showed the gross 230/230 under rows that add up to 120/120.
 */
describe('CR-2026-10-15 trial balance footer — real-Postgres', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let journals: JournalEntryService;
  let ledger: LedgerService;
  const actor = randomUUID();
  const year = new Date().toISOString().slice(0, 4);
  const today = new Date().toISOString().slice(0, 10);
  const acc = { cash: randomUUID(), payable: randomUUID(), revenue: randomUUID(), expense: randomUUID(), suspense: randomUUID() };
  const accB = { cash: randomUUID(), revenue: randomUUID() };

  async function seedPeriod(companyId: string) {
    const ds = await h.connections.getDataSource(companyId);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'TB',$2) ON CONFLICT DO NOTHING`, [actor, `tb-${companyId}@test.local`]);
    const fy = randomUUID();
    const fp = randomUUID();
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fy, randomUUID(), fp],
    );
    return ds;
  }

  async function post(companyId: string, dr: string, cr: string, amount: string): Promise<string> {
    const m = (await h.connections.getDataSource(companyId)).manager;
    const d = await journals.createEntry(
      { sourceType: 'MANUAL', businessDate: today, description: 'TB footer', transactionCurrencyCode: 'EGP', lines: [{ accountId: dr, debit: amount }, { accountId: cr, credit: amount }] },
      actor,
      m,
    );
    await journals.postEntry(d.id, actor, {}, m);
    return d.id;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'tb_footer', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    const dsA = await seedPeriod(h.companyAId);
    await dsA.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive") VALUES
       ($1,'1000','Cash','asset','debit',true,true,true), ($2,'2000','Payable','liability','credit',true,true,true),
       ($3,'4000','Revenue','revenue','credit',true,true,true), ($4,'5000','Expense','expense','debit',true,true,true),
       ($5,'1999','Suspense','asset','debit',true,true,true)`,
      [acc.cash, acc.payable, acc.revenue, acc.expense, acc.suspense],
    );
    const dsB = await seedPeriod(h.companyBId);
    await dsB.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive") VALUES
       ($1,'1000','Cash','asset','debit',true,true,true), ($2,'4000','Revenue','revenue','credit',true,true,true)`,
      [accB.cash, accB.revenue],
    );

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    for (const ds of [dsA, dsB]) await numbering.registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const events = new EventBusService(inert);
    const currencies = new CurrencyService(h.controlPlane, audit);
    const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    const config = { get: () => undefined } as unknown as ConfigurationEngineService;
    journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
    ledger = new LedgerService(h.controlPlane);

    const j1 = await post(h.companyAId, acc.cash, acc.revenue, '100.00');
    await dsA.query(`UPDATE accounting_journal_entries SET "businessDate" = $2 WHERE id = $1`, [j1, `${year}-01-15`]);
    await post(h.companyAId, acc.expense, acc.cash, '40.00');
    await post(h.companyAId, acc.suspense, acc.cash, '25.00');
    await post(h.companyAId, acc.cash, acc.suspense, '25.00');
    await post(h.companyAId, acc.payable, acc.cash, '10.00');
    await post(h.companyAId, acc.cash, acc.payable, '30.00');
    // A draft (unposted) entry must never count.
    await journals.createEntry(
      { sourceType: 'MANUAL', businessDate: today, description: 'draft', transactionCurrencyCode: 'EGP', lines: [{ accountId: acc.cash, debit: '999.00' }, { accountId: acc.revenue, credit: '999.00' }] },
      actor,
      dsA.manager,
    );
    // Company B: one-sided activity only.
    await post(h.companyBId, accB.cash, accB.revenue, '250.00');
  });

  afterAll(async () => {
    await h.teardown();
  });

  const sum = (values: string[]) => values.reduce((s, v) => s + Math.round(Number(v) * 10_000), 0) / 10_000;

  it('rows are the net balance per account: debit balance, credit balance, a credit-normal account, zero-balance omitted, drafts excluded', async () => {
    const tb = await ledger.getTrialBalanceReport({}, (await h.connections.getDataSource(h.companyAId)).manager);
    expect(tb.rows.map((r) => [r.code, r.debitBase, r.creditBase])).toEqual([
      ['1000', '80.0000', '0.0000'],
      ['2000', '0.0000', '20.0000'],
      ['4000', '0.0000', '100.0000'],
      ['5000', '40.0000', '0.0000'],
    ]);
  });

  it('the footer totals equal the sums of the displayed rows (120 / 120), while the gross activity fields keep their meaning (230 / 230)', async () => {
    const tb = await ledger.getTrialBalanceReport({}, (await h.connections.getDataSource(h.companyAId)).manager);
    expect(tb.balanceTotalDebitBase).toBe('120.0000');
    expect(tb.balanceTotalCreditBase).toBe('120.0000');
    expect(Number(tb.balanceTotalDebitBase)).toBe(sum(tb.rows.map((r) => r.debitBase)));
    expect(Number(tb.balanceTotalCreditBase)).toBe(sum(tb.rows.map((r) => r.creditBase)));
    expect(tb.totalDebitBase).toBe('230.0000');
    expect(tb.totalCreditBase).toBe('230.0000');
    expect(tb.balanced).toBe(true);
  });

  it('getTrialBalance (closing snapshot / ledger overview) is unchanged — no new fields, same gross totals', async () => {
    const tb = await ledger.getTrialBalance({}, (await h.connections.getDataSource(h.companyAId)).manager);
    expect(Object.keys(tb).sort()).toEqual(['balanced', 'rows', 'totalCreditBase', 'totalDebitBase']);
    expect(tb.totalDebitBase).toBe('230.0000');
  });

  it('a date window reconciles the same way (from = 1 Feb excludes J1: Cash 20 Cr, Payable 20 Cr, Expense 40 Dr)', async () => {
    const tb = await ledger.getTrialBalanceReport({ from: `${year}-02-01` }, (await h.connections.getDataSource(h.companyAId)).manager);
    expect(tb.rows.map((r) => [r.code, r.debitBase, r.creditBase])).toEqual([
      ['1000', '0.0000', '20.0000'],
      ['2000', '0.0000', '20.0000'],
      ['5000', '40.0000', '0.0000'],
    ]);
    expect([tb.balanceTotalDebitBase, tb.balanceTotalCreditBase]).toEqual(['40.0000', '40.0000']);
    expect([tb.totalDebitBase, tb.totalCreditBase]).toEqual(['130.0000', '130.0000']);
  });

  it('one-sided activity: footer and gross agree (Company B 250 / 250), and Company A never leaks into B', async () => {
    const tb = await ledger.getTrialBalanceReport({}, (await h.connections.getDataSource(h.companyBId)).manager);
    expect(tb.rows.map((r) => r.code)).toEqual(['1000', '4000']);
    expect([tb.balanceTotalDebitBase, tb.balanceTotalCreditBase, tb.totalDebitBase, tb.totalCreditBase]).toEqual(['250.0000', '250.0000', '250.0000', '250.0000']);
  });

  it('independent check: 40 randomised mixed postings — footer = Σ displayed rows, gross = Σ posted amounts, both recomputed outside SQL', async () => {
    const ds = await h.connections.getDataSource(h.companyBId);
    const extra = Array.from({ length: 4 }, () => randomUUID());
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive") VALUES
       ($1,'1100','Bank','asset','debit',true,true,true), ($2,'2100','Accrual','liability','credit',true,true,true),
       ($3,'5100','Rent','expense','debit',true,true,true), ($4,'4100','Fees','revenue','credit',true,true,true)`,
      extra,
    );
    const before = await ledger.getTrialBalanceReport({}, ds.manager);
    const accounts = [accB.cash, accB.revenue, ...extra];
    const net = new Map<string, number>(); // in ten-thousandths, exact integer arithmetic
    let grossAdded = 0;
    let seed = 20261015;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 40; i++) {
      const dr = accounts[Math.floor(rnd() * accounts.length)];
      let cr = accounts[Math.floor(rnd() * accounts.length)];
      if (cr === dr) cr = accounts[(accounts.indexOf(dr) + 1) % accounts.length];
      const cents = 1 + Math.floor(rnd() * 99_999);
      await post(h.companyBId, dr, cr, (cents / 100).toFixed(2));
      net.set(dr, (net.get(dr) ?? 0) + cents * 100);
      net.set(cr, (net.get(cr) ?? 0) - cents * 100);
      grossAdded += cents * 100;
    }
    // Fold in the 250.00 already posted in Company B (Dr cash / Cr revenue).
    net.set(accB.cash, (net.get(accB.cash) ?? 0) + 2_500_000);
    net.set(accB.revenue, (net.get(accB.revenue) ?? 0) - 2_500_000);

    const tb = await ledger.getTrialBalanceReport({}, ds.manager);
    const t4 = (v: string) => Math.round(Number(v) * 10_000);
    // Rows carry exactly the expected net per account (zero nets omitted).
    const expectedRows = [...net.entries()].filter(([, v]) => v !== 0).map(([id, v]) => [id, Math.max(v, 0), Math.max(-v, 0)]);
    expect(tb.rows.map((r) => [r.accountId, t4(r.debitBase), t4(r.creditBase)]).sort()).toEqual(expectedRows.sort());
    // Screen totals = sum of the displayed rows.
    expect(t4(tb.balanceTotalDebitBase)).toBe(tb.rows.reduce((s, r) => s + t4(r.debitBase), 0));
    expect(t4(tb.balanceTotalCreditBase)).toBe(tb.rows.reduce((s, r) => s + t4(r.creditBase), 0));
    expect(tb.balanceTotalDebitBase).toBe(tb.balanceTotalCreditBase);
    // Gross contract = previous gross + every amount posted here, on each side.
    expect(t4(tb.totalDebitBase)).toBe(t4(before.totalDebitBase) + grossAdded);
    expect(t4(tb.totalCreditBase)).toBe(t4(before.totalCreditBase) + grossAdded);
    expect(tb.balanced).toBe(true);
  });

  it('an empty window returns zero totals and no rows', async () => {
    const tb = await ledger.getTrialBalanceReport({ from: `${Number(year) + 1}-01-01` }, (await h.connections.getDataSource(h.companyAId)).manager);
    expect(tb.rows).toEqual([]);
    expect([tb.balanceTotalDebitBase, tb.balanceTotalCreditBase, tb.totalDebitBase, tb.totalCreditBase]).toEqual(['0.0000', '0.0000', '0.0000', '0.0000']);
    expect(tb.balanced).toBe(true);
  });
});
