import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { HrService } from '../../domains/hr/application/hr.service';
import { TargetService } from '../../domains/targets/application/target.service';
import { AttendanceService } from '../../domains/attendance/application/attendance.service';
import { CommissionService } from '../../domains/commission/application/commission.service';
import { PayrollService } from '../../domains/payroll/application/payroll.service';
import { PayrollSodService } from '../../domains/payroll/application/payroll-sod.service';
import { PayrollExceptionService } from '../../domains/payroll/application/payroll-exception.service';
import { PayrollPayoutService } from '../../domains/payroll/application/payroll-payout.service';
import { PayrollRun } from '../../domains/payroll/infrastructure/payroll-run.entity';
import { TreasuryService } from '../../domains/treasury/application/treasury.service';
import { GLAccountService } from '../../domains/accounting/application/gl-account.service';
import { CurrencyService } from '../../domains/accounting/application/currency.service';
import { FiscalPeriodService } from '../../domains/accounting/application/fiscal-period.service';
import { FinancialDimensionService } from '../../domains/accounting/application/financial-dimension.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../../domains/accounting/application/journal-entry.service';
import { FinancialEventService } from '../../domains/accounting/application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../../domains/accounting/application/financial-events/handler-registry';
import { LimitService } from '../limit-engine/limit.service';
import { AuditService } from '../audit/audit.service';
import { EventBusService } from '../events/event-bus.service';
import { OrganizationService } from '../organization/organization.service';
import { NumberingService } from '../numbering/numbering.service';
import { ApprovalEngineService } from '../approval-engine/approval-engine.service';
import { ProcessEngineService } from '../process-engine/process-engine.service';
import { PermissionService } from '../permission/permission.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { ExcelService } from '../excel/excel.service';
import { ConfigurationEngineService } from '../configuration-engine/configuration-engine.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from './two-company-real-pg-harness';
import { createAmbientDataSource } from './ambient-test-datasource';

export type CompanyKey = 'A' | 'B';

/**
 * Gap-closure test fixture (2026-10-25): the REAL HR / Attendance / Targets / Commission / Payroll / Treasury services and the REAL Financial Event -> journal
 * pipeline, wired against two disposable Company databases (never mocked), plus a small chart (5201, 2150, 1102), a fiscal year/period and five Company users:
 * `prep` (calculates), `rev` (reviews, acknowledges exceptions), `sub` (submits), `appr` (approves), `pay` (disburses). Used only by specs.
 */
export async function buildPayrollFixture(namePrefix: string) {
  const h: TwoCompanyHarness = await setUpTwoCompanyHarness({
    namePrefix,
    extraCompanyTags: ['sales', 'inventory', 'finance', 'accounting', 'hr', 'attendance', 'targets', 'commission', 'payroll'],
  });
  const ambient: DataSource = await createAmbientDataSource(h);
  const inert = {} as never;
  const audit = new AuditService(ambient);
  const events = new EventBusService(inert, h.connections);
  const limits = new LimitService(ambient, { sync: async () => undefined } as never, audit);
  const processEngine = new ProcessEngineService(ambient);
  const numbering = new NumberingService(ambient);
  const approvals = new ApprovalEngineService(ambient, processEngine, audit, events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
  const hr = new HrService(ambient, limits, events, audit, new OrganizationService(ambient), numbering, approvals, h.users, h.memberships);
  const targets = new TargetService(ambient, audit, events, approvals, processEngine, hr);
  const attendance = new AttendanceService(ambient, audit, events, approvals, new ExcelService(), hr);
  const commission = new CommissionService(ambient, audit, events, approvals, processEngine, hr, targets);
  const sod = new PayrollSodService(ambient, audit);
  const exceptions = new PayrollExceptionService(ambient, audit, sod);
  const treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
  const payouts = new PayrollPayoutService(ambient, audit, events, numbering, sod, treasury);
  const payroll = new PayrollService(ambient, audit, events, approvals, processEngine, numbering, hr, attendance, commission, sod, exceptions, payouts);

  // accounting pipeline (same wiring as the D2 / wages-payable specs)
  const config = { get: () => undefined } as unknown as ConfigurationEngineService;
  const currencies = new CurrencyService(h.controlPlane, audit);
  const glAccounts = new GLAccountService(h.controlPlane, audit, events, limits, inert, currencies);
  const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
  const dimensions = new FinancialDimensionService(h.controlPlane, audit);
  const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
  const financialEvents = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), config);
  financialEvents.onModuleInit();

  await hr.onModuleInit();
  await targets.onModuleInit();
  await attendance.onModuleInit();
  await commission.onModuleInit();
  await payroll.onModuleInit();
  await payouts.onModuleInit();

  const idOf = (k: CompanyKey) => (k === 'A' ? h.companyAId : h.companyBId);
  const dsOf = (k: CompanyKey) => h.connections.getDataSource(idOf(k));
  const mgr = async (k: CompanyKey): Promise<EntityManager> => (await dsOf(k)).manager;
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);

  type Roles = 'prep' | 'rev' | 'sub' | 'appr' | 'pay' | 'extra';
  const users: Record<CompanyKey, Record<Roles, string>> = { A: {} as never, B: {} as never };
  const treasuryAccounts: Record<CompanyKey, { mapped: string; unmapped: string }> = { A: { mapped: '', unmapped: '' }, B: { mapped: '', unmapped: '' } };

  async function seedCompany(k: CompanyKey): Promise<void> {
    const ds = await dsOf(k);
    for (const r of ['prep', 'rev', 'sub', 'appr', 'pay', 'extra'] as Roles[]) users[k][r] = (await h.createUserWithAdminRoleIn(`Pay ${r} ${k}`, idOf(k))).id;
    const role = (await ds.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    for (const node of ['payroll.run.approve']) {
      await ds.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable') ON CONFLICT DO NOTHING`, [role.id, node]);
    }
    for (const [code, name, type, normal, fn] of [
      ['1102', 'Bank', 'asset', 'debit', 'bank'],
      ['2150', 'Wages Payable', 'liability', 'credit', 'wages_payable'],
      ['5201', 'Salaries and Wages Expense', 'expense', 'debit', null],
    ] as Array<[string, string, string, string, string | null]>) {
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
    await numbering.registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
    const types = await treasury.listAccountTypes(ds.manager);
    const bankType = types.find((t) => t.code === 'bank')!;
    const mapped = await treasury.createAccount(`PAYBANK-${k}`, `Payroll bank ${k}`, bankType.id, users[k].pay, ds.manager);
    await treasury.setAccountGlMapping(mapped.id, '1102', users[k].pay, ds.manager);
    const unmapped = await treasury.createAccount(`PAYUNMAPPED-${k}`, `Unmapped ${k}`, bankType.id, users[k].pay, ds.manager);
    treasuryAccounts[k] = { mapped: mapped.id, unmapped: unmapped.id };
    await fund(k, treasuryAccounts[k].mapped, '100000.00');
    await fund(k, treasuryAccounts[k].unmapped, '100000.00');
  }

  async function fund(k: CompanyKey, accountId: string, amount: string): Promise<void> {
    await treasury.cashIn(accountId, amount, null, null, null, 'fixture funding', users[k].pay, await mgr(k)); // non-emitting
  }

  async function drain(k: CompanyKey): Promise<void> {
    const m = await mgr(k);
    for (let i = 0; i < 30; i++) {
      const r = await events.dispatchAfterCommit(m);
      if (r.dispatched + r.failed === 0) return;
    }
    throw new Error('outbox did not drain');
  }

  async function employee(k: CompanyKey, fullName: string, amount: string | null, opts: { effectiveFrom?: string; employmentType?: 'full_time' | 'part_time' | 'contractor'; hireDate?: string } = {}): Promise<string> {
    const m = await mgr(k);
    const e = await hr.createEmployee({ fullName, employmentType: opts.employmentType ?? 'full_time', hireDate: opts.hireDate }, users[k].prep, m);
    if (amount !== null) await payroll.createCompensation({ employeeId: e.id, earnings: [{ componentCode: 'basic', amount }], effectiveFrom: opts.effectiveFrom ?? '2026-01-01', reason: 'fixture' }, users[k].prep, m);
    return e.id;
  }

  async function period(k: CompanyKey, code: string, startDate: string, endDate: string): Promise<string> {
    return (await payroll.createPeriod({ code, startDate, endDate }, users[k].prep, await mgr(k))).id;
  }

  /** Acknowledge every open acknowledgeable exception of the run (as `rev`, who did not prepare it). */
  async function acknowledgeAll(k: CompanyKey, runId: string, by: string = users[k].rev): Promise<void> {
    const m = await mgr(k);
    const open = (await payroll.listExceptions(runId, m)).filter((e) => e.impactClass === 'A_DOC' && e.status === 'open');
    for (const code of [...new Set(open.map((e) => e.code))]) await payroll.acknowledgeExceptions(runId, { code }, `DEC-${code}`, by, m);
  }

  /** calculate (prep) -> acknowledge+review (rev) -> submit (sub) -> approve (appr) -> posted; returns the run row. */
  async function postRun(k: CompanyKey, periodId: string): Promise<PayrollRun> {
    const m = await mgr(k);
    const run = await payroll.calculate(periodId, users[k].prep, m);
    await acknowledgeAll(k, run.id);
    await payroll.review(run.id, users[k].rev, m);
    const submitted = await payroll.submitForApproval(run.id, users[k].sub, m);
    await payroll.decide(submitted.approvalRequestId!, users[k].appr, 'approved', null, m);
    await drain(k);
    return (await payroll.getRun(run.id, m)).run;
  }

  async function ledger(k: CompanyKey): Promise<{ expense: string; payable: string }> {
    const rows: Array<{ code: string; net: string }> = await (await dsOf(k)).query(
      `SELECT a.code, SUM(jl."debitBase" - jl."creditBase")::text AS net FROM accounting_journal_lines jl JOIN accounting_gl_accounts a ON a.id = jl."accountId" GROUP BY a.code`,
    );
    const by = new Map(rows.map((r) => [r.code, r.net]));
    return { expense: by.get('5201') ?? '0', payable: by.get('2150') ?? '0' };
  }

  async function teardown(): Promise<void> {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('payroll fixture teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  }

  await seedCompany('A');
  await seedCompany('B');

  return {
    h, ambient, hr, targets, attendance, commission, payroll, sod, exceptions, payouts, treasury, glAccounts, financialEvents, events, approvals, processEngine,
    users, treasuryAccounts, today, idOf, dsOf, mgr, fund, drain, employee, period, acknowledgeAll, postRun, ledger, teardown,
  };
}

export type PayrollFixture = Awaited<ReturnType<typeof buildPayrollFixture>>;
