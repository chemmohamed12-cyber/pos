import { randomUUID } from 'crypto';
import { JournalEntryService } from '../application/journal-entry.service';
import { LedgerService } from '../application/ledger.service';
import { FinancialReportingService } from '../application/financial-reporting.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../application/financial-events/handler-registry';
import { GLAccountService } from '../application/gl-account.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { JournalEntry } from '../infrastructure/journal-entry.entity';
import { JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-10-04, CTO-authorized).
 * Real-Postgres proof that `general-ledger.controller.ts`'s journal, ledger,
 * reporting, and financial-event routes are genuinely Company-scoped — two
 * real, separately provisioned Company databases, each with its own chart
 * fragment, fiscal year/period, and a journal of a *different* amount
 * (100.00 vs 250.00), so any cross-Company leak is immediately visible in a
 * total.
 *
 * Every service is built with an inert ambient DataSource for the *business*
 * path (the control-plane connection is passed only where a service needs an
 * ambient fallback that no call below ever takes — every call supplies its
 * own Company manager, which always wins). The Configuration Engine is a
 * stub: it is installation-wide (Matrix §45, Gate D), not Company-scoped,
 * and is not what this controller's routes exercise.
 */
describe('GeneralLedgerController Area 21 retrofit — real-Postgres Company isolation (2026-10-04)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let journals: JournalEntryService;
  let ledger: LedgerService;
  let reporting: FinancialReportingService;
  let financialEvents: FinancialEventService;
  const actorUserId = randomUUID();

  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const FIGURES = { A: '100.00', B: '250.00' } as const;
  const EVENT_TYPE = 'isolation.gl.test';

  const seeded: Record<'A' | 'B', { cashId: string; revenueId: string }> = {
    A: { cashId: '', revenueId: '' },
    B: { cashId: '', revenueId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B') {
    const ds = await h.connections.getDataSource(companyId);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Accountant',
      `iso-gl-${companyId}@test.local`,
    ]);

    const cashId = randomUUID();
    const revenueId = randomUUID();
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive")
       VALUES ($1,$2,$3,'asset','debit',true,true,true), ($4,$5,$6,'revenue','credit',true,true,true)`,
      [cashId, `1000-${key}`, `${key} Cash`, revenueId, `4000-${key}`, `${key} Revenue`],
    );
    seeded[key] = { cashId, revenueId };

    // A fiscal year + one period spanning it, both seeded directly in their
    // open states (raw insert — same precedent as the payments spec seeding
    // a migration-shaped process instance — so the posting gate has a real
    // open period to find without re-deriving `createFiscalYear`'s approval flow).
    const fiscalYearId = randomUUID();
    const fiscalPeriodId = randomUUID();
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,$2,$3,$4)`, [
      fiscalYearId,
      `FY-${key}`,
      `${year}-01-01`,
      `${year}-12-31`,
    ]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,$3,$4,$5)`, [
      fiscalPeriodId,
      fiscalYearId,
      `P-${key}`,
      `${year}-01-01`,
      `${year}-12-31`,
    ]);
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fiscalYearId, randomUUID(), fiscalPeriodId],
    );
  }

  const manualJournal = (key: 'A' | 'B') => ({
    sourceType: 'MANUAL' as const,
    businessDate: today,
    description: `Isolation journal ${key}`,
    transactionCurrencyCode: 'EGP',
    lines: [
      { accountId: seeded[key].cashId, debit: FIGURES[key] },
      { accountId: seeded[key].revenueId, credit: FIGURES[key] },
    ],
  });

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({
      namePrefix: 'general_ledger_isolation',
      extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'],
    });
    await seedCompanyData(h.companyAId, 'A');
    await seedCompanyData(h.companyBId, 'B');

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const config = { get: () => undefined } as unknown as ConfigurationEngineService;

    // The JV numbering sequence is registered per Company (the module-init
    // hook is installation-wide and is not what this controller exercises).
    for (const id of [h.companyAId, h.companyBId]) {
      const ds = await h.connections.getDataSource(id);
      await numbering.registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
    }

    const currencies = new CurrencyService(h.controlPlane, audit);
    const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
    ledger = new LedgerService(h.controlPlane);
    reporting = new FinancialReportingService(h.controlPlane);

    const registry = new FinancialEventHandlerRegistry();
    registry.register(EVENT_TYPE, async (event, ctx) => {
      const key = String(event.payload.key) as 'A' | 'B';
      const cash = await ctx.findAccountByCode(`1000-${key}`);
      const revenue = await ctx.findAccountByCode(`4000-${key}`);
      if (!cash || !revenue) return { kind: 'rejected', reason: 'accounts not found in this Company' };
      return {
        kind: 'draft',
        draft: {
          businessDate: event.businessDate,
          description: 'Isolation financial event',
          transactionCurrencyCode: ctx.baseCurrencyCode,
          orgUnitId: null,
          lines: [
            { accountId: cash, debit: '40.00' },
            { accountId: revenue, credit: '40.00' },
          ],
        },
      };
    });
    financialEvents = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, registry, config);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("create → submit → post for Company A lands entirely in Company A's database (numbered, POSTED) — Company B sees nothing", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);

    const draft = await journals.createEntry(manualJournal('A'), actorUserId, dsA.manager);
    expect(draft.status).toBe('DRAFT');
    expect((await journals.submitEntry(draft.id, actorUserId, dsA.manager)).status).toBe('VALIDATED');
    const posted = await journals.postEntry(draft.id, actorUserId, {}, dsA.manager);
    expect(posted.status).toBe('POSTED');
    expect(posted.entryNumber).toMatch(/^JV/);
    expect(posted.totalDebitBase).toBe('100.0000');

    expect(await dsA.getRepository(JournalEntry).findOne({ where: { id: draft.id } })).toBeTruthy();
    expect(await dsB.getRepository(JournalEntry).count()).toBe(0);
    expect(await journals.listEntries({}, dsB.manager)).toEqual([]);
  });

  it("Company B posts its own, different journal (250.00) independently — Company A's list is unchanged", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);

    const draft = await journals.createEntry(manualJournal('B'), actorUserId, dsB.manager);
    const posted = await journals.postEntry(draft.id, actorUserId, {}, dsB.manager);
    expect(posted.status).toBe('POSTED');
    expect(posted.totalDebitBase).toBe('250.0000');

    expect((await journals.listEntries({}, dsA.manager)).map((e) => e.totalDebitBase)).toEqual(['100.0000']);
    expect((await journals.listEntries({}, dsB.manager)).map((e) => e.totalDebitBase)).toEqual(['250.0000']);
  });

  it("getEntry / updateEntry / submitEntry / postEntry / reverseEntry of Company A's journal id through Company B's manager are all rejected (A→B DENY)", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const [aEntry] = await journals.listEntries({}, dsA.manager);

    await expect(journals.getEntry(aEntry.id, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(journals.updateEntry(aEntry.id, { description: 'hijack' }, actorUserId, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(journals.submitEntry(aEntry.id, actorUserId, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(journals.postEntry(aEntry.id, actorUserId, {}, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(journals.reverseEntry(aEntry.id, actorUserId, {}, dsB.manager)).rejects.toThrow(/not found/i);
  });

  it("B→A DENY — Company B's journal id through Company A's manager is rejected", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const [bEntry] = await journals.listEntries({}, dsB.manager);
    await expect(journals.getEntry(bEntry.id, dsA.manager)).rejects.toThrow(/not found/i);
    await expect(journals.reverseEntry(bEntry.id, actorUserId, {}, dsA.manager)).rejects.toThrow(/not found/i);
  });

  it("trial balance / account ledger are per-Company — A totals 100.00, B totals 250.00, never the sum; a foreign account id is rejected", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);

    const tbA = await ledger.getTrialBalance({}, dsA.manager);
    expect(tbA.totalDebitBase).toBe('100.0000');
    expect(tbA.rows.map((r) => r.code).sort()).toEqual(['1000-A', '4000-A']);
    const tbB = await ledger.getTrialBalance({}, dsB.manager);
    expect(tbB.totalDebitBase).toBe('250.0000');
    expect(tbB.rows.map((r) => r.code).sort()).toEqual(['1000-B', '4000-B']);

    const lA = await ledger.getAccountLedger(seeded.A.cashId, {}, dsA.manager);
    expect(lA.closingBalanceBase).toBe('100.0000');
    expect(lA.lines).toHaveLength(1);
    await expect(ledger.getAccountLedger(seeded.A.cashId, {}, dsB.manager)).rejects.toThrow(/not found/i);
  });

  it('balance sheet / P&L / cash-flow are per-Company (A 100.00 vs B 250.00) and a foreign tax period id is not found', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);

    expect((await reporting.getBalanceSheet({ asOfDate: today }, dsA.manager)).assetsTotal).toBe('100.0000');
    expect((await reporting.getBalanceSheet({ asOfDate: today }, dsB.manager)).assetsTotal).toBe('250.0000');

    expect((await reporting.getProfitAndLoss({ from: `${year}-01-01`, to: today }, dsA.manager)).revenueTotal).toBe('100.0000');
    expect((await reporting.getProfitAndLoss({ from: `${year}-01-01`, to: today }, dsB.manager)).revenueTotal).toBe('250.0000');

    await expect(reporting.getCashFlowStatement({ from: `${year}-01-01`, to: today }, dsA.manager)).resolves.toBeDefined();
    await expect(reporting.getTaxPeriodSummary(randomUUID(), dsA.manager)).rejects.toThrow(/not found/i);
  });

  it('financial event ingest for Company A posts a journal in Company A only; list/get/redrive are per-Company', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);

    const result = await financialEvents.ingest(
      EVENT_TYPE,
      { key: 'A', sourceEntityId: randomUUID(), businessDate: today, currency: 'EGP' },
      dsA.manager,
    );
    expect(result.status).toBe('POSTED');
    expect(result.journalEntryId).toBeTruthy();

    const eventsA = await financialEvents.listEvents({}, dsA.manager);
    expect(eventsA).toHaveLength(1);
    expect(await financialEvents.listEvents({}, dsB.manager)).toEqual([]);

    // The event's journal is in A, not in B, and A's trial balance moved by exactly 40.00.
    expect((await journals.getEntry(result.journalEntryId as string, dsA.manager)).status).toBe('POSTED');
    await expect(journals.getEntry(result.journalEntryId as string, dsB.manager)).rejects.toThrow(/not found/i);
    expect((await ledger.getTrialBalance({}, dsA.manager)).totalDebitBase).toBe('140.0000');
    expect((await ledger.getTrialBalance({}, dsB.manager)).totalDebitBase).toBe('250.0000');

    await expect(financialEvents.getEvent(eventsA[0].id, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(financialEvents.redrive(eventsA[0].id, dsB.manager)).rejects.toThrow(/not found/i);
    expect((await financialEvents.redrive(eventsA[0].id, dsA.manager)).deduped).toBe(true);
  });

  it("reversing Company A's journal nets A's trial balance accordingly and leaves Company B untouched", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const original = (await journals.listEntries({ sourceType: 'MANUAL' }, dsA.manager))[0];

    const { original: reversed, reversal } = await journals.reverseEntry(original.id, actorUserId, {}, dsA.manager);
    expect(reversed.status).toBe('REVERSED');
    expect(reversal.status).toBe('POSTED');
    expect(reversal.reversalOfEntryId).toBe(original.id);

    // Gross debit lines posted in A: 100 (original) + 100 (reversal) + 40 (event) = 240.00;
    // net by account only the event's 40.00 remains.
    const tbA = await ledger.getTrialBalance({}, dsA.manager);
    expect(tbA.totalDebitBase).toBe('240.0000');
    expect(tbA.rows.map((r) => r.debitBase).filter((v) => v !== '0.0000')).toEqual(['40.0000']);
    expect((await ledger.getTrialBalance({}, dsB.manager)).totalDebitBase).toBe('250.0000');
    expect((await journals.listEntries({}, dsB.manager)).filter((e) => e.sourceType === 'REVERSAL')).toEqual([]);
  });

  it("Test F — resolving Company A's general-ledger data never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await journals.listEntries({}, dsA.manager);
      await ledger.getTrialBalance({}, dsA.manager);
      await reporting.getBalanceSheet({ asOfDate: today }, dsA.manager);
      await financialEvents.listEvents({}, dsA.manager);
      const draft = await journals.createEntry(manualJournal('A'), actorUserId, dsA.manager);
      await journals.postEntry(draft.id, actorUserId, {}, dsA.manager);
    });
  });
});
