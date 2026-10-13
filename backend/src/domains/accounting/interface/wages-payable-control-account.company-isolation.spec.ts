import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { IFRS_SME_TEMPLATE } from '../domain/account-templates/ifrs-sme.template';
import { GLAccountService } from '../application/gl-account.service';
import { CurrencyService } from '../application/currency.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../application/financial-events/handler-registry';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { LimitService } from '../../../foundation/limit-engine/limit.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';

/**
 * ACCOUNTING GAP — WAGES PAYABLE CONTROL ACCOUNT (WP-PAY-01 finding, closeout 2026-10-13; documented fix scope in
 * `docs/decisions/WAGES-PAYABLE-CONTROL-ACCOUNT-TEMPLATE-2026-10-13.md`; same pattern as the WIP fix H2).
 *
 * Measured at runtime by WP-PAY-01 (`evidence-clean-snapshot-2026-10-13/3bf740b-wp-pay-01/`): a freshly provisioned Company had
 * no active postable `wages_payable` control account, so `payroll.run.posted` produced a REJECTED Financial Event while the
 * PayrollRun itself showed `posted`. The `ifrs-sme` template now carries `2150 Wages Payable` (liability, credit-normal, control
 * `wages_payable`, parent `21`). Chart DATA only: the importer, the handler (`payroll-run-posted.handler.ts`), the Event Engine
 * and the posting gate are untouched, and nothing is changed in any existing Company.
 *
 * Real Postgres, two disposable Company databases, NO hand-seeded account:
 *   A — a fresh Company imports the template; the real payroll posting handler posts `Dr 5201 / Cr 2150` for the run total.
 *   B — a chart that PRE-DATES the fix (template imported, 2150 removed) still fails closed with the explicit reason, and the
 *       documented recovery (create/assign the control function, re-drive the event) posts it.
 * This spec decides no payroll accounting policy (H0-4 / DEC-03): it asserts only that the control account the already-ratified
 * handler requires exists in a fresh chart and that the existing posting shape is reachable.
 */
describe('Wages Payable control account in the ifrs-sme template — static template contract', () => {
  const wp = IFRS_SME_TEMPLATE.accounts.filter((a) => a.controlFunction === 'wages_payable');

  it('carries exactly one wages_payable control account: 2150, liability, postable, under Current Liabilities, never contra', () => {
    expect(wp).toHaveLength(1);
    expect(wp[0]).toMatchObject({ code: '2150', accountType: 'liability', parentCode: '21', controlFunction: 'wages_payable' });
    expect(wp[0].isPostable ?? true).toBe(true);
    expect(wp[0].isContra ?? false).toBe(false);
  });

  it('is ordered parents-before-children, has no duplicate code, and 2150 does not collide with another account', () => {
    const codes = IFRS_SME_TEMPLATE.accounts.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    const seen = new Set<string>();
    for (const a of IFRS_SME_TEMPLATE.accounts) {
      if (a.parentCode) expect(seen.has(a.parentCode)).toBe(true);
      seen.add(a.code);
    }
  });

  it('the salaries expense account the payroll handler debits (5201) is in the template too — both legs resolvable from the template alone', () => {
    expect(IFRS_SME_TEMPLATE.accounts.find((a) => a.code === '5201')).toMatchObject({ accountType: 'expense' });
  });
});

describe('Wages Payable control account — real-Postgres, template import -> payroll.run.posted GL posting', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let glAccounts: GLAccountService;
  let events: EventBusService;
  let financialEvents: FinancialEventService;
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';
  const ds = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function seedCompany(k: Key) {
    const d = await ds(k);
    await d.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Payroll Accountant',$2) ON CONFLICT DO NOTHING`, [actor, `wp-${k}@test.local`]);
    const fy = randomUUID();
    const fp = randomUUID();
    await d.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await d.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await d.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fy, randomUUID(), fp],
    );
    await new NumberingService(ambient).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, d.manager);
  }

  /** `importTemplate` leaves one outbox row per account; drain them (as the per-Company scheduler would) so the payroll event that follows is dispatched in-request. */
  async function drainOutbox(k: Key) {
    const m = (await ds(k)).manager;
    for (let i = 0; i < 20; i++) {
      const r = await events.dispatchAfterCommit(m);
      if (r.dispatched + r.failed === 0) return;
    }
    throw new Error('outbox did not drain');
  }

  /** The exact payload `PayrollService.onApprovalApproved` publishes (see payroll.service.ts), for a run of the given total. */
  async function postPayrollRun(k: Key, total: string): Promise<string> {
    const d = await ds(k);
    const runId = randomUUID();
    await d.transaction(async (manager) => {
      await events.publish(manager, 'payroll.run.posted', {
        sourceEntityType: 'PayrollRun',
        sourceEntityId: runId,
        payrollRunId: runId,
        payrollPeriodId: randomUUID(),
        totalGross: total,
        totalNet: total,
        employeeCount: 1,
      });
    });
    await drainOutbox(k);
    return runId;
  }

  async function eventOf(k: Key, runId: string) {
    const rows: Array<{ id: string; status: string; rejectionReason: string | null; journalEntryId: string | null }> = await (await ds(k)).query(
      `SELECT id, status, "rejectionReason", "journalEntryId" FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
      [runId],
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function journalLines(k: Key, journalEntryId: string) {
    return (await (await ds(k)).query(
      `SELECT a."code", a."controlFunction", jl."debitBase"::text AS debit, jl."creditBase"::text AS credit
       FROM accounting_journal_lines jl JOIN accounting_gl_accounts a ON a.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY jl."lineNumber"`,
      [journalEntryId],
    )) as Array<{ code: string; controlFunction: string | null; debit: string; credit: string }>;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'wages_payable_ctl', extraCompanyTags: ['sales', 'inventory', 'finance', 'accounting'] });
    ambient = await createAmbientDataSource(h);
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    events = new EventBusService(inert, h.connections);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const config = { get: () => undefined } as unknown as ConfigurationEngineService;
    const limits = new LimitService(ambient, { sync: async () => undefined } as never, audit);
    const currencies = new CurrencyService(h.controlPlane, audit);
    glAccounts = new GLAccountService(h.controlPlane, audit, events, limits, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
    financialEvents = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), config);
    financialEvents.onModuleInit();
    await seedCompany('A');
    await seedCompany('B');
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown();
  });

  it('A — a fresh Company imports the ifrs-sme template: ONE active postable wages_payable control account (2150) appears, shaped like every other control account', async () => {
    const mA = (await ds('A')).manager;
    expect(await glAccounts.listAccounts({}, mA)).toEqual([]); // genuinely fresh
    const result = await glAccounts.importTemplate('ifrs-sme', false, actor, mA);
    expect(result.created).toBe(IFRS_SME_TEMPLATE.accounts.length);
    await drainOutbox('A');

    const wp = (await glAccounts.listAccounts({}, mA)).filter((a) => a.controlFunction === 'wages_payable');
    expect(wp).toHaveLength(1);
    expect(wp[0]).toMatchObject({ code: '2150', accountType: 'liability', normalBalance: 'credit', isPostable: true, isActive: true, isContra: false, allowManualJournal: false, currencyMode: 'functional_only' });
    expect((await glAccounts.getAccount(wp[0].parentAccountId!, mA)).code).toBe('21'); // Current Liabilities
  });

  it('A — payroll.run.posted POSTS with the template-only chart (no hand-seeded account): Dr 5201 / Cr 2150 for the run total, balanced, nothing else touched', async () => {
    const runId = await postPayrollRun('A', '5000.00');
    const fe = await eventOf('A', runId);
    expect(fe).toMatchObject({ status: 'POSTED', rejectionReason: null });
    expect(await journalLines('A', fe.journalEntryId!)).toEqual([
      { code: '5201', controlFunction: null, debit: '5000.0000', credit: '0.0000' },
      { code: '2150', controlFunction: 'wages_payable', debit: '0.0000', credit: '5000.0000' },
    ]);
  });

  it('B — a chart that PRE-DATES the fix (template imported without 2150) still fails closed with the explicit reason: REJECTED, nothing posted', async () => {
    const dB = await ds('B');
    const mB = dB.manager;
    await glAccounts.importTemplate('ifrs-sme', false, actor, mB);
    await dB.query(`DELETE FROM accounting_gl_accounts WHERE code = '2150'`); // emulate a Company provisioned before this change
    await drainOutbox('B');
    expect((await glAccounts.listAccounts({}, mB)).filter((a) => a.controlFunction === 'wages_payable')).toEqual([]);

    const runId = await postPayrollRun('B', '1200.00');
    const fe = await eventOf('B', runId);
    expect(fe.status).toBe('REJECTED');
    expect(fe.journalEntryId).toBeNull();
    expect(fe.rejectionReason).toMatch(/no Wages Payable control account in the chart/);
    expect(await dB.query(`SELECT 1 FROM accounting_journal_entries`)).toEqual([]);
    (globalThis as { __wpRunB?: string }).__wpRunB = runId;
  });

  it('B — documented recovery: create a wages_payable control account in that chart, re-drive the REJECTED event -> POSTED Dr 5201 / Cr wages payable', async () => {
    const mB = (await ds('B')).manager;
    const header = await glAccounts.getAccountByCode('21', mB);
    const created = await glAccounts.createAccount({ code: '2150', name: 'Wages Payable', accountType: 'liability', parentAccountId: header.id, controlFunction: 'wages_payable' }, actor, mB);
    expect(created.controlFunction).toBe('wages_payable');

    const runId = (globalThis as { __wpRunB?: string }).__wpRunB!;
    const rejected = await eventOf('B', runId);
    const redriven = await financialEvents.redrive(rejected.id, mB);
    expect(redriven.status).toBe('POSTED');
    expect(await journalLines('B', redriven.journalEntryId!)).toEqual([
      { code: '5201', controlFunction: null, debit: '1200.0000', credit: '0.0000' },
      { code: '2150', controlFunction: 'wages_payable', debit: '0.0000', credit: '1200.0000' },
    ]);
  });

  it('Isolation — each Company owns its own wages_payable account; A\'s posting never appears in B and vice-versa', async () => {
    const mA = (await ds('A')).manager;
    const mB = (await ds('B')).manager;
    const a = await glAccounts.getAccountByCode('2150', mA);
    const b = await glAccounts.getAccountByCode('2150', mB);
    expect(a.id).not.toBe(b.id);
    const sum = async (k: Key, accountId: string) =>
      Number((await (await ds(k)).query(`SELECT COALESCE(SUM("creditBase"),0)::text AS c FROM accounting_journal_lines WHERE "accountId" = $1`, [accountId]))[0].c);
    expect(await sum('A', a.id)).toBe(5000);
    expect(await sum('B', b.id)).toBe(1200);
  });
});
