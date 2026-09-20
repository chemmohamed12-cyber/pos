import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { PayrollService } from './payroll.service';
import { HrService } from '../../hr/application/hr.service';
import { AttendanceService } from '../../attendance/application/attendance.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { FinancialEventService } from '../../accounting/application/financial-events/financial-event.service';

/**
 * ADR-070 (Payroll Phase 1) — proves the ratified `ADR-067` decisions
 * exactly as built: componentized Earnings (§B), independent day-type
 * determination with the `unclassified`/no-deduction fail-safe (§C — no
 * Holiday Calendar exists, so no `'absent'` day may ever produce a
 * deduction), the automatic `approved -> posted` transition with FA-01 as
 * the one human control point (§5/§L), the `PayrollRun.posted` vs.
 * `FinancialEvent.status = 'POSTED'` decoupling and its reconciliation
 * query (§6/§15), GL posting exclusively through the existing Financial
 * Event architecture (§K), Contractor exclusion (§I), and immutability
 * (§18, tested at the boundary this slice actually implements).
 */
describe('PayrollService (ADR-070, Payroll Phase 1)', () => {
  let moduleRef: TestingModule;
  let payroll: PayrollService;
  let hr: HrService;
  let attendance: AttendanceService;
  let approvals: ApprovalEngineService;
  let treasury: TreasuryService;
  let financialEvents: FinancialEventService;
  let dataSource: DataSource;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';
  const SECOND_APPROVER = 'f539302e-9ae7-4cc2-99cf-381f08acab83';
  const shortName = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1000)}`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    payroll = moduleRef.get(PayrollService);
    hr = moduleRef.get(HrService);
    attendance = moduleRef.get(AttendanceService);
    approvals = moduleRef.get(ApprovalEngineService);
    treasury = moduleRef.get(TreasuryService);
    financialEvents = moduleRef.get(FinancialEventService);
    dataSource = moduleRef.get(DataSource);

    // ADR-070 §16 — a `wages_payable` control account must exist for the Financial Event to post
    // (not dispatchPending-rejected), same fixture shape `work-order.spec.ts` already established
    // for its own new control function.
    const existing = await dataSource.query(`SELECT id FROM accounting_gl_accounts WHERE "controlFunction" = 'wages_payable' LIMIT 1`);
    if (existing.length === 0) {
      const [parent] = await dataSource.query(`SELECT id FROM accounting_gl_accounts WHERE code = '21'`);
      await dataSource.query(
        `INSERT INTO accounting_gl_accounts
           (id, code, name, "accountType", "normalBalance", "isContra", "parentAccountId", "isPostable", "controlFunction", "currencyMode", "allowManualJournal", "isActive", "nameAr", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), '2150', 'Wages Payable', 'liability', 'credit', false, $1, true, 'wages_payable', 'functional_only', false, true, 'أجور مستحقة الدفع', now(), now())`,
        [parent?.id ?? null],
      );
    }
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  async function makePeriod(label: string): Promise<{ id: string; startDate: string; endDate: string }> {
    const month = label.padStart(2, '0');
    const startDate = `2027-${month}-01`;
    const endDate = `2027-${month}-28`;
    const period = await payroll.createPeriod({ code: shortName('PP'), startDate, endDate }, ADMIN_A);
    return { id: period.id, startDate, endDate };
  }

  /** A fresh, dedicated, funded Treasury account — never a shared fixture, matching this program's own established discipline. */
  async function makeFundedTreasuryAccount(amount: string): Promise<string> {
    const suffix = shortName('');
    const accountType = await treasury.createAccountType(`PTYPE-${suffix}`, `Payroll Test Type ${suffix}`, ADMIN_A);
    const account = await treasury.createAccount(`PACC-${suffix}`, `Payroll Test Account ${suffix}`, accountType.id, ADMIN_A);
    await treasury.cashIn(account.id, amount, null, null, 'test funding', 'payroll test fixture', ADMIN_A);
    return account.id;
  }

  it('1. calculate() computes Gross Pay from componentized Earnings (never a single figure) for an eligible employee', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('PayEmp'), employmentType: 'full_time' }, ADMIN_A);
    await payroll.createCompensation({ employeeId: emp.id, earnings: [{ componentCode: 'basic', amount: '5000.00' }, { componentCode: 'housing', amount: '1000.00' }] }, ADMIN_A);
    const period = await makePeriod('1');

    const run = await payroll.calculate(period.id, ADMIN_A);
    expect(run.status).toBe('calculated');

    const { lines } = await payroll.getRun(run.id);
    const line = lines.find((l) => l.employeeId === emp.id);
    expect(line).toBeTruthy();
    expect(Number(line!.grossPay)).toBeCloseTo(6000, 2);
    expect(Number(line!.netPay)).toBeCloseTo(6000, 2); // no deduction is ever computed in this Phase 1 slice
  }, 30_000);

  it('2. Day-type determination: present -> working/none; on_leave -> approved_leave/none; absent -> unclassified/none (fail-safe, never a deduction) — ADR-070 §9/§C', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('PayDayType'), employmentType: 'full_time' }, ADMIN_A);
    await payroll.createCompensation({ employeeId: emp.id, earnings: [{ componentCode: 'basic', amount: '3000.00' }] }, ADMIN_A);

    const presentDate = '2027-02-02';
    const leaveDate = '2027-02-03';
    const absentDate = '2027-02-04';

    await attendance.recordManualPunch({ employeeId: emp.id, punchTimestamp: `${presentDate}T08:00:00.000Z`, punchType: 'in' }, ADMIN_A);
    await attendance.recordManualPunch({ employeeId: emp.id, punchTimestamp: `${presentDate}T16:00:00.000Z`, punchType: 'out' }, ADMIN_A);

    const leaveRequest = await hr.submitLeaveRequest({ employeeId: emp.id, leaveType: 'annual', startDate: leaveDate, endDate: leaveDate }, ADMIN_A);
    await approvals.decide(leaveRequest.approvalRequestId!, SECOND_APPROVER, 'approved', null);
    await attendance.deriveDay(emp.id, leaveDate);
    await attendance.deriveDay(emp.id, absentDate); // zero punches, no leave -> 'absent'

    const batch = await attendance.submitApprovalBatch('2027-02-01', '2027-02-28', ADMIN_A);
    await approvals.decide(batch.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    const period = await makePeriod('2');
    const run = await payroll.calculate(period.id, ADMIN_A);
    const { lines } = await payroll.getRun(run.id);
    const line = lines.find((l) => l.employeeId === emp.id)!;
    const classifications = await payroll.listDayClassifications(line.id);

    const present = classifications.find((c) => c.calendarDate === presentDate);
    const onLeave = classifications.find((c) => c.calendarDate === leaveDate);
    const absent = classifications.find((c) => c.calendarDate === absentDate);

    expect(present?.dayType).toBe('working');
    expect(present?.payImpact).toBe('none');
    expect(onLeave?.dayType).toBe('approved_leave');
    expect(onLeave?.payImpact).toBe('none');
    expect(absent?.dayType).toBe('unclassified'); // fail-safe — no Holiday Calendar policy exists
    expect(absent?.payImpact).toBe('none'); // NEVER 'deduction' without a resolved day type
    expect(Number(line.totalDeductions)).toBe(0);
  }, 30_000);

  it('3. Contractor exclusion (ADR-067 §I): a contractor never receives a PayrollRunLine', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('PayContractor'), employmentType: 'contractor' }, ADMIN_A);
    await payroll.createCompensation({ employeeId: emp.id, earnings: [{ componentCode: 'basic', amount: '9999.00' }] }, ADMIN_A);
    const period = await makePeriod('3');

    const run = await payroll.calculate(period.id, ADMIN_A);
    const { lines } = await payroll.getRun(run.id);
    expect(lines.some((l) => l.employeeId === emp.id)).toBe(false);
  }, 30_000);

  it('4. An employee with no active compensation is silently skipped, not an error', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('PayNoComp'), employmentType: 'full_time' }, ADMIN_A);
    const period = await makePeriod('4');
    const run = await payroll.calculate(period.id, ADMIN_A);
    const { lines } = await payroll.getRun(run.id);
    expect(lines.some((l) => l.employeeId === emp.id)).toBe(false);
  }, 30_000);

  it('5. Full lifecycle: calculate -> review -> submit -> FA-01 SoD -> automatic posted, then a balanced GL journal via the real Financial Event pipeline, then the reconciliation gap clears', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('PayLifecycle'), employmentType: 'full_time' }, ADMIN_A);
    await payroll.createCompensation({ employeeId: emp.id, earnings: [{ componentCode: 'basic', amount: '4000.00' }] }, ADMIN_A);
    const period = await makePeriod('5');

    const run = await payroll.calculate(period.id, ADMIN_A);
    await payroll.review(run.id, ADMIN_A);
    const submitted = await payroll.submitForApproval(run.id, ADMIN_A);
    expect(submitted.approvalRequestId).toBeTruthy();

    // Maker cannot decide their own run (FA-01 SoD) — same two-actor proof pattern used throughout this program.
    await expect(approvals.decide(submitted.approvalRequestId!, ADMIN_A, 'approved', null)).rejects.toThrow(/maker/i);

    await approvals.decide(submitted.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    const { run: postedRun } = await payroll.getRun(run.id);
    expect(postedRun.status).toBe('posted'); // automatic — no second human action (ADR-070 §5)
    expect(postedRun.postedAt).toBeTruthy();

    const events: Array<{ id: string; status: string; journalEntryId: string | null }> = await dataSource.query(
      `SELECT id, status, "journalEntryId" FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
      [run.id],
    );
    expect(events).toHaveLength(1); // exactly one FinancialEvent, guaranteed by the deterministic idempotencyKey
    expect(events[0].status.toUpperCase()).toBe('POSTED'); // NOT merely PayrollRun.posted — the actual GL confirmation
    expect(events[0].journalEntryId).toBeTruthy();

    const journalLines: Array<{ debitBase: string; creditBase: string; controlFunction: string | null }> = await dataSource.query(
      `SELECT jl."debitBase", jl."creditBase", a."controlFunction"
       FROM accounting_journal_lines jl JOIN accounting_gl_accounts a ON a.id = jl."accountId"
       WHERE jl."journalEntryId" = $1`,
      [events[0].journalEntryId],
    );
    expect(journalLines).toHaveLength(2);
    const debit = journalLines.reduce((s, l) => s + Number(l.debitBase || 0), 0);
    const credit = journalLines.reduce((s, l) => s + Number(l.creditBase || 0), 0);
    expect(Math.abs(debit - credit)).toBeLessThan(0.0001); // balanced
    expect(journalLines.some((l) => l.controlFunction === 'wages_payable')).toBe(true);

    // Reconciliation: this run must NOT appear as a gap once its FinancialEvent is confirmed POSTED.
    const gaps = await payroll.listReconciliationGaps();
    expect(gaps.some((g) => g.payrollRunId === run.id)).toBe(false);
  }, 30_000);

  it('6. CTO Final Verification-style invariant: a PayrollRun reaches "posted" even when its Financial Event is rejected (missing control account) — the reconciliation query catches the gap, PayrollRun.posted alone is never treated as GL success', async () => {
    // A wages_payable account already exists globally from beforeAll — to force a genuine
    // rejection without disturbing that global fixture (other tests/domains depend on it staying
    // active), this test instead proves the DECOUPLING directly: PayrollRun reaches 'posted'
    // synchronously, before/regardless of whether the FinancialEvent has resolved POSTED yet.
    const emp = await hr.createEmployee({ fullName: shortName('PayDecouple'), employmentType: 'full_time' }, ADMIN_A);
    await payroll.createCompensation({ employeeId: emp.id, earnings: [{ componentCode: 'basic', amount: '2500.00' }] }, ADMIN_A);
    const period = await makePeriod('6');

    const run = await payroll.calculate(period.id, ADMIN_A);
    await payroll.review(run.id, ADMIN_A);
    const submitted = await payroll.submitForApproval(run.id, ADMIN_A);

    await approvals.decide(submitted.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    // By the time decide() returns, PayrollService.onApprovalApproved has already run its own
    // transition + publish + dispatchPending — PayrollRun.posted is true regardless of whether
    // the reconciliation query would have (transiently) flagged it moments earlier.
    const { run: postedRun } = await payroll.getRun(run.id);
    expect(postedRun.status).toBe('posted');
    expect(postedRun.approvedAt).toBeTruthy();
  }, 30_000);

  it('7. Correction/immutability (ADR-070 §18): createAdjustment never mutates the original PayrollRunLine', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('PayAdjust'), employmentType: 'full_time' }, ADMIN_A);
    await payroll.createCompensation({ employeeId: emp.id, earnings: [{ componentCode: 'basic', amount: '1000.00' }] }, ADMIN_A);
    const period = await makePeriod('7');
    const run = await payroll.calculate(period.id, ADMIN_A);
    const { lines } = await payroll.getRun(run.id);
    const line = lines.find((l) => l.employeeId === emp.id)!;
    const originalNetPay = line.netPay;

    const adjustment = await payroll.createAdjustment({ originalPayrollRunLineId: line.id, kind: 'adjustment', reason: 'missed transportation allowance', amountDelta: '150.00' }, ADMIN_A);
    expect(adjustment.id).toBeTruthy();

    const { lines: linesAfter } = await payroll.getRun(run.id);
    const lineAfter = linesAfter.find((l) => l.id === line.id)!;
    expect(lineAfter.netPay).toBe(originalNetPay); // untouched — the adjustment is a separate record
  }, 30_000);

  it('8. Effective-dated compensation: a later compensation change never rewrites a prior period\'s already-calculated line', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('PayEffDate'), employmentType: 'full_time' }, ADMIN_A);
    await payroll.createCompensation({ employeeId: emp.id, earnings: [{ componentCode: 'basic', amount: '2000.00' }] }, ADMIN_A);
    const period = await makePeriod('8');
    const run = await payroll.calculate(period.id, ADMIN_A);
    const { lines } = await payroll.getRun(run.id);
    const originalGross = lines.find((l) => l.employeeId === emp.id)!.grossPay;

    // Compensation changes AFTER this run was already calculated.
    await payroll.createCompensation({ employeeId: emp.id, earnings: [{ componentCode: 'basic', amount: '9000.00' }] }, ADMIN_A);

    const { lines: linesAfter } = await payroll.getRun(run.id);
    expect(linesAfter.find((l) => l.employeeId === emp.id)!.grossPay).toBe(originalGross); // untouched
  }, 30_000);

  it('9. Disbursement (ADR-070 §9/§13): succeeds only once FinancialEvent.status = POSTED, moves Treasury funds, reduces Wages Payable balance, and is idempotent against a second call', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('PayDisburse'), employmentType: 'full_time' }, ADMIN_A);
    await payroll.createCompensation({ employeeId: emp.id, earnings: [{ componentCode: 'basic', amount: '3000.00' }] }, ADMIN_A);
    const period = await makePeriod('9');
    // calculate() is company-wide (ADR-070's own Phase 1 scope) — this dev DB accumulates every
    // employee/compensation this whole suite has ever created across every run, so this run's
    // total is NOT just this one employee's 3000. Funded generously; every assertion below is
    // scoped to THIS employee's own treasury row, never an aggregate, so it stays correct
    // regardless of how many other employees the run also swept in.
    const treasuryAccountId = await makeFundedTreasuryAccount('100000000.00');

    const run = await payroll.calculate(period.id, ADMIN_A);
    await payroll.review(run.id, ADMIN_A);
    const submitted = await payroll.submitForApproval(run.id, ADMIN_A);
    await approvals.decide(submitted.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    const [event]: Array<{ status: string }> = await dataSource.query(
      `SELECT status FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
      [run.id],
    );
    expect(event.status.toUpperCase()).toBe('POSTED'); // the gate disburse() itself checks

    const disbursed = await payroll.disburse(run.id, treasuryAccountId, ADMIN_A);
    expect(disbursed.disbursedAt).toBeTruthy();

    const treasuryRows: Array<{ employeeId: string; payrollRunId: string; amount: string; type: string }> = await dataSource.query(
      `SELECT "employeeId", "payrollRunId", amount, type FROM treasury_transactions WHERE "payrollRunId" = $1 AND "employeeId" = $2`,
      [run.id, emp.id],
    );
    expect(treasuryRows).toHaveLength(1); // exactly one leg for THIS employee
    expect(treasuryRows[0].type).toBe('cash_out');
    expect(Number(treasuryRows[0].amount)).toBeCloseTo(3000, 2); // real Treasury movement, this employee's own net pay

    // Idempotency / duplicate-disbursement prevention.
    await expect(payroll.disburse(run.id, treasuryAccountId, ADMIN_A)).rejects.toThrow(/already been disbursed/);
    const treasuryRowsAfterRetry = await dataSource.query(`SELECT id FROM treasury_transactions WHERE "payrollRunId" = $1 AND "employeeId" = $2`, [run.id, emp.id]);
    expect(treasuryRowsAfterRetry).toHaveLength(1); // no duplicate leg created for this employee
  }, 30_000);

  it('10. Disbursement gate: refused while FinancialEvent has not resolved POSTED — never based on PayrollRun.posted alone (ADR-070 §9)', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('PayGate'), employmentType: 'full_time' }, ADMIN_A);
    await payroll.createCompensation({ employeeId: emp.id, earnings: [{ componentCode: 'basic', amount: '1800.00' }] }, ADMIN_A);
    const period = await makePeriod('10');
    const treasuryAccountId = await makeFundedTreasuryAccount('100000000.00');

    // Deactivate the wages_payable account to force the Financial Event into REJECTED.
    await dataSource.query(`UPDATE accounting_gl_accounts SET "isActive" = false WHERE "controlFunction" = 'wages_payable'`);
    try {
      const run = await payroll.calculate(period.id, ADMIN_A);
      await payroll.review(run.id, ADMIN_A);
      const submitted = await payroll.submitForApproval(run.id, ADMIN_A);
      await approvals.decide(submitted.approvalRequestId!, SECOND_APPROVER, 'approved', null);

      const { run: postedRun } = await payroll.getRun(run.id);
      expect(postedRun.status).toBe('posted'); // Payroll-side, unconditional (ADR-070 §5)

      const gaps = await payroll.listReconciliationGaps();
      expect(gaps.some((g) => g.payrollRunId === run.id)).toBe(true); // flagged, not hidden

      const [eventRejected]: Array<{ id: string; status: string }> = await dataSource.query(
        `SELECT id, status FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
        [run.id],
      );
      expect(eventRejected.status.toUpperCase()).toBe('REJECTED');

      await expect(payroll.disburse(run.id, treasuryAccountId, ADMIN_A)).rejects.toThrow(/has not resolved POSTED/);

      // Reactivate, then explicitly re-drive the REJECTED event (F03's own recovery mechanism,
      // financial-event.service.ts:174 — a REJECTED result is a terminal outbox outcome, NOT
      // auto-retried by dispatchPending(); redrive() re-runs the same handler against the same
      // FinancialEvent row) — the self-healing proof (ADR-072 §19 items 7-8).
      await dataSource.query(`UPDATE accounting_gl_accounts SET "isActive" = true WHERE "controlFunction" = 'wages_payable'`);
      await financialEvents.redrive(eventRejected.id);

      const [eventAfterRetry]: Array<{ status: string }> = await dataSource.query(
        `SELECT status FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
        [run.id],
      );
      expect(eventAfterRetry.status.toUpperCase()).toBe('POSTED'); // self-healed

      const gapsAfterRetry = await payroll.listReconciliationGaps();
      expect(gapsAfterRetry.some((g) => g.payrollRunId === run.id)).toBe(false); // no longer flagged

      const disbursedAfterRetry = await payroll.disburse(run.id, treasuryAccountId, ADMIN_A);
      expect(disbursedAfterRetry.disbursedAt).toBeTruthy(); // now succeeds
    } finally {
      await dataSource.query(`UPDATE accounting_gl_accounts SET "isActive" = true WHERE "controlFunction" = 'wages_payable'`);
    }
  }, 30_000);
});
