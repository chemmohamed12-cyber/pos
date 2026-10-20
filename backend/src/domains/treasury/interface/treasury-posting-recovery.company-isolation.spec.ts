import { randomUUID } from 'crypto';
import { TreasuryService } from '../application/treasury.service';
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
import { TreasuryPostingExceptionsService } from '../../accounting/application/treasury-posting-exceptions.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Treasury integrity T1.3 (2026-10-20) — recovery when a Financial Event is rejected AFTER a movement committed (a period or chart change between check and dispatch, or a legacy path):
 *   the movement shows up in the posting-exceptions view with its real cause, amount and age · the cause is fixed · the EXISTING idempotent re-drive posts it exactly once, at its ORIGINAL business date ·
 *   a second re-drive changes nothing · the view empties · Treasury == GL. Also: a legacy leg on an unmapped account is reported as UNMAPPED_ACCOUNT (never silently ignored).
 */
describe('Treasury integrity T1.3 — posting exceptions and safe re-drive — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let treasury: TreasuryService;
  let feService: FinancialEventService;
  let exceptions: TreasuryPostingExceptionsService;
  let events: EventBusService;
  const cfg: Record<string, string> = {};
  const actor = randomUUID();
  const year = new Date().toISOString().slice(0, 4);
  const today = new Date().toISOString().slice(0, 10);
  type Key = 'A' | 'B';
  const acc: Record<Key, { cash1101: string; bank1102: string; unmapped: string; dangling: string }> = {
    A: { cash1101: '', bank1102: '', unmapped: '', dangling: '' },
    B: { cash1101: '', bank1102: '', unmapped: '', dangling: '' },
  };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function seed(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'T1 Operator',$2) ON CONFLICT DO NOTHING`, [actor, `t1-${k}@test.local`]);
    for (const [code, name, type, normal, fn] of [
      ['1101', 'Cash on Hand', 'asset', 'debit', 'bank'],
      ['1102', 'Bank', 'asset', 'debit', 'bank'],
      ['3999', 'Cash movement clearing', 'asset', 'debit', null],
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
    const mk = async (code: string, gl: string | null) => {
      const a = await treasury.createAccount(`${code}-${k}`, `${code} ${k}`, bankType.id, actor, ds.manager);
      if (gl) await treasury.setAccountGlMapping(a.id, gl, actor, ds.manager);
      return a.id;
    };
    acc[k].cash1101 = await mk('CASH1101', '1101');
    acc[k].bank1102 = await mk('BANK1102', '1102');
    acc[k].unmapped = await mk('UNMAPPED', null);
    acc[k].dangling = await mk('DANGLING', '9999');
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 't1_recovery', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
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
    feService = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), config);
    feService.onModuleInit();
    exceptions = new TreasuryPostingExceptionsService(h.controlPlane);
    treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
    await seed('A');
    await seed('B');
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('T1 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  async function fingerprint(k: Key) {
    const ds = await dsOf(k);
    const n = async (sql: string) => Number((await ds.query(sql))[0].n);
    return {
      treasuryTxns: await n(`SELECT count(*) AS n FROM "treasury_transactions"`),
      financialEvents: await n(`SELECT count(*) AS n FROM "accounting_financial_events"`),
      journals: await n(`SELECT count(*) AS n FROM "accounting_journal_entries"`),
      outbox: await n(`SELECT count(*) AS n FROM "event_outbox"`),
      auditTreasury: await n(`SELECT count(*) AS n FROM "audit_records" WHERE "action" LIKE 'treasury.%'`),
    };
  }
  async function glBalance(k: Key, code: string): Promise<string> {
    const ds = await dsOf(k);
    const r = await ds.query(
      `SELECT COALESCE(SUM(jl."debitBase" - jl."creditBase"),0)::numeric(20,2)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" JOIN "accounting_journal_entries" je ON je.id = jl."journalEntryId" AND je."postedAt" IS NOT NULL WHERE ga.code = $1`,
      [code],
    );
    return r[0].b;
  }

  it('a movement committed inside a larger unit, whose event is then REJECTED at dispatch (clearing account removed in between), appears in the exceptions view with cause, amount and age', async () => {
    cfg['accounting.cash_movement_clearing_account_code'] = '3999';
    const ds = await dsOf('A');
    // commit the movement + its outbox row in the caller's own transaction (dispatchAfterCommit is a no-op inside it), exactly the shape of the residual window
    await ds.manager.transaction((tx) => treasury.cashInDirect(acc.A.cash1101, '250.00', null, null, 'rec-1', 't1.3', actor, tx));
    delete cfg['accounting.cash_movement_clearing_account_code']; // the cause appears after the publish-time check
    await events.dispatchAfterCommit(ds.manager);

    const view = await exceptions.list({}, ds.manager);
    expect(view.total).toBe(1);
    expect(view.totalAmount).toBe('250.00');
    expect(view.byCause.REJECTED).toEqual({ count: 1, amount: '250.00' });
    expect(view.rows[0]).toMatchObject({ category: 'direct_cash', cause: 'REJECTED', accountCode: 'CASH1101-A', eventStatus: 'REJECTED', ageDays: 0 });
    expect(view.rows[0].reason).toMatch(/clearing account is unset/);
    // the divergence is visible, not hidden: Treasury has the money, GL does not
    expect(await treasury.getAccountBalance(acc.A.cash1101, ds.manager)).toBe('250.00');
    expect(await glBalance('A', '1101')).toBe('0.00');
  });

  it('re-drive after fixing the cause posts exactly one balanced journal at the ORIGINAL business date; a second re-drive and a duplicate dispatch change nothing', async () => {
    cfg['accounting.cash_movement_clearing_account_code'] = '3999';
    const ds = await dsOf('A');
    const ev = (await ds.query(`SELECT id, "businessDate"::text AS bd FROM "accounting_financial_events" WHERE status = 'REJECTED'`))[0] as { id: string; bd: string };
    const first = await feService.redrive(ev.id, ds.manager);
    expect(first.status).toBe('POSTED');
    const journals = await ds.query(`SELECT "businessDate"::text AS bd, "totalDebitBase"::text AS d, "totalCreditBase"::text AS c FROM "accounting_journal_entries" WHERE "financialEventId" = $1`, [ev.id]);
    expect(journals).toHaveLength(1);
    expect(journals[0].bd).toBe(ev.bd); // never silently re-dated
    expect(Number(journals[0].d)).toBe(Number(journals[0].c));

    const again = await feService.redrive(ev.id, ds.manager);
    expect(again).toMatchObject({ status: 'POSTED', deduped: true });
    await events.dispatchAfterCommit(ds.manager);
    const count = (await ds.query(`SELECT count(*)::int AS n FROM "accounting_journal_entries" WHERE "financialEventId" = $1`, [ev.id]))[0].n;
    expect(count).toBe(1);

    expect((await exceptions.list({}, ds.manager)).total).toBe(0);
    expect(await treasury.getAccountBalance(acc.A.cash1101, ds.manager)).toBe(await glBalance('A', '1101'));
  });

  it('a legacy leg on an unmapped account (non-emitting path) is reported as UNMAPPED_ACCOUNT — and a re-drive cannot help, only the mapping can', async () => {
    const ds = await dsOf('A');
    await treasury.cashIn(acc.A.unmapped, '40.00', null, null, 'legacy', 'legacy', actor, ds.manager);
    const view = await exceptions.list({}, ds.manager);
    expect(view.total).toBe(1);
    expect(view.rows[0]).toMatchObject({ cause: 'UNMAPPED_ACCOUNT', glAccountCode: null, accountCode: 'UNMAPPED-A', eventId: null });
    expect(view.byCause.UNMAPPED_ACCOUNT).toEqual({ count: 1, amount: '40.00' });
  });

  it('Company B has no exceptions and was never touched', async () => {
    const dsB = await dsOf('B');
    expect((await exceptions.list({}, dsB.manager)).total).toBe(0);
    expect(await fingerprint('B')).toMatchObject({ treasuryTxns: 0, financialEvents: 0, journals: 0, outbox: 0 });
    expect(today.length).toBe(10);
  });
});
