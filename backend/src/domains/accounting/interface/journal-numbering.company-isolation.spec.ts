import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { JournalEntryService } from '../application/journal-entry.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../application/financial-events/handler-registry';
import { GLAccountService } from '../application/gl-account.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';

const DOC = 'accounting_journal_entry';

/**
 * Company-scoped journal numbering (2026-10-06, CTO-authorised fix for the defect found by Browser Verification #1: "No numbering sequence
 * registered for document type accounting_journal_entry" on the first post in a freshly provisioned Company database).
 *
 * NOTHING in this spec registers a journal numbering sequence — not in setup, not in a test. The Company databases are built by the real
 * migration/provisioning pipeline (the two-Company harness), exactly as a freshly provisioned Company, and `JournalEntryService.onModuleInit`
 * is deliberately NOT called (it only ever touches the ambient database). Real PostgreSQL, Company A with Company B as the witness.
 */
describe('Company-scoped journal numbering — fresh Company, no manual setup — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let journals: JournalEntryService;
  let financialEvents: FinancialEventService;
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';
  const acc: Record<Key, { cash: string; revenue: string; bank: string; ar: string }> = { A: { cash: '', revenue: '', bank: '', ar: '' }, B: { cash: '', revenue: '', bank: '', ar: '' } };
  const mgr = async (k: Key) => (await h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId)).manager;

  async function seedChart(k: Key, companyId: string) {
    const ds = await h.connections.getDataSource(companyId);
    const ids = { cash: randomUUID(), revenue: randomUUID(), bank: randomUUID(), ar: randomUUID() };
    acc[k] = ids;
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","isContra","controlFunction") VALUES
       ($1,'1105','Cash','asset','debit',true,true,true,false,NULL),
       ($2,'4100','Sales','revenue','credit',true,true,true,false,NULL),
       ($3,'1102','Bank','asset','debit',true,false,true,false,'bank'),
       ($4,'1110','Accounts Receivable','asset','debit',true,false,true,false,'ar')`,
      [ids.cash, ids.revenue, ids.bank, ids.ar],
    );
    const fy = randomUUID();
    const fp = randomUUID();
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fy, randomUUID(), fp],
    );
    // deliberately NO numbering sequence here
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'jnl_numbering', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    ambient = await createAmbientDataSource(h);
    await seedChart('A', h.companyAId);
    await seedChart('B', h.companyBId);
    const inert = {} as never;
    const audit = new AuditService(ambient);
    const numbering = new NumberingService(ambient);
    const events = new EventBusService(inert, h.connections);
    const process = new ProcessEngineService(ambient);
    const cfg = { get: () => undefined } as unknown as ConfigurationEngineService;
    const currencies = new CurrencyService(ambient, audit);
    const glAccounts = new GLAccountService(ambient, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(ambient, process, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(ambient, audit);
    journals = new JournalEntryService(ambient, glAccounts, fiscalPeriods, currencies, audit, events, numbering, process, cfg, dimensions);
    financialEvents = new FinancialEventService(ambient, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), cfg);
    financialEvents.onModuleInit();
    // NOT called: journals.onModuleInit() / ensureNumberingRegistered() — the ambient registration must not be what makes Company posting work.
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('journal numbering teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  const sequences = async (k: Key) => (await (await mgr(k)).query(`SELECT prefix, "includeYear", "lastNumber", "lastYear" FROM numbering_sequences WHERE "documentType" = $1`, [DOC])) as Array<{ prefix: string; includeYear: boolean; lastNumber: number; lastYear: number | null }>;
  async function manualJournal(k: Key, amount: string, post = true) {
    const m = await mgr(k);
    const e = await journals.createEntry(
      { sourceType: 'MANUAL', businessDate: today, description: `numbering ${k} ${amount}`, transactionCurrencyCode: 'EGP', lines: [{ accountId: acc[k].cash, debit: amount }, { accountId: acc[k].revenue, credit: amount }] },
      actor,
      m,
    );
    if (!post) return e.id;
    const posted = await journals.postEntry(e.id, actor, {}, m);
    return posted.entryNumber as string;
  }

  it('0. PRECONDITION: a fresh Company database has NO journal sequence, and neither does the Platform/ambient database', async () => {
    expect(await sequences('A')).toEqual([]);
    expect(await sequences('B')).toEqual([]);
    expect(Number((await ambient.query(`SELECT count(*) AS n FROM numbering_sequences WHERE "documentType" = $1`, [DOC]))[0].n)).toBe(0);
  });

  it('1. COMPANY A (fresh, no SQL): a real manual journal is created and POSTED with a correct number; the next one continues A\'s own sequence', async () => {
    const bBefore = await sequences('B');
    let first = '';
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      first = await manualJournal('A', '100');
    });
    expect(first).toBe(`JV-${year}-000001`);
    expect(await manualJournal('A', '200')).toBe(`JV-${year}-000002`);
    expect(await sequences('A')).toEqual([{ prefix: 'JV', includeYear: true, lastNumber: 2, lastYear: Number(year) }]);
    expect(await sequences('B')).toEqual(bBefore); // B untouched
  });

  it('2. COMPANY B (fresh): its own sequence starts at 1 — it does NOT continue A\'s count; TWO simultaneous first posts in B both succeed with distinct numbers (race-safe registration)', async () => {
    const a = await manualJournal('B', '50', false);
    const b = await manualJournal('B', '60', false);
    const mB = await mgr('B');
    const settled = await Promise.all([journals.postEntry(a, actor, {}, mB), journals.postEntry(b, actor, {}, mB)]);
    expect(settled.map((s) => s.entryNumber).sort()).toEqual([`JV-${year}-000001`, `JV-${year}-000002`]);
    expect(await sequences('B')).toEqual([{ prefix: 'JV', includeYear: true, lastNumber: 2, lastYear: Number(year) }]);
    expect((await sequences('A'))[0].lastNumber).toBe(2); // A's counter was not pulled by B
  });

  it('3. EVENT-DRIVEN GL posting in a Company whose sequence is created lazily: finance.payment.recorded → POSTED journal numbered from THAT Company\'s sequence', async () => {
    const mA = await mgr('A');
    const paymentId = randomUUID();
    const result = await financialEvents.ingest(
      'finance.payment.recorded',
      { idempotencyKey: `numbering:${paymentId}`, sourceEntityType: 'payment', sourceEntityId: paymentId, payloadVersion: 1, businessDate: today, orgUnitId: null, currency: 'EGP', paymentId, paymentNumber: 'PAY-N-1', amount: '75.00', glAccountCode: '1102' },
      mA,
    );
    expect(result.status).toBe('POSTED');
    const entry = (await mA.query(`SELECT "entryNumber", "sourceType" FROM accounting_journal_entries WHERE id = $1`, [result.journalEntryId]))[0];
    expect(entry.entryNumber).toBe(`JV-${year}-000003`); // continues A's sequence (2 manual posts before it)
    expect((await sequences('A'))[0].lastNumber).toBe(3);
    expect((await sequences('B'))[0].lastNumber).toBe(2);
  });

  it('4. ISOLATION: the Platform/ambient database never became a numbering source; each Company\'s sequence row lives only in its own database', async () => {
    expect(Number((await ambient.query(`SELECT count(*) AS n FROM numbering_sequences WHERE "documentType" = $1`, [DOC]))[0].n)).toBe(0);
    expect(Number((await ambient.query(`SELECT count(*) AS n FROM accounting_journal_entries`).catch(() => [{ n: 0 }]))[0].n)).toBe(0);
    // an ambient-style call (no Company manager) is unchanged: it uses the ambient database and its own (separately registered) sequence
    expect((await sequences('A')).length).toBe(1);
    expect((await sequences('B')).length).toBe(1);
  });
});
