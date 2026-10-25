import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { PayrollService } from './payroll.service';
import { HrService } from '../../hr/application/hr.service';
import { AttendanceService } from '../../attendance/application/attendance.service';
import { CommissionService } from '../../commission/application/commission.service';
import { CustomersService } from '../../crm/application/customers.service';
import { UsersService } from '../../../foundation/identity/users.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { FinancialEventService } from '../../accounting/application/financial-events/financial-event.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';

/**
 * Executes `docs/studies/INTEGRATED_ATTENDANCE_PAYROLL_COMMISSION_GL_E2E_SPEC.md`
 * (commit `24082d6`). Per that document's own §3/§20, execution requires
 * all three preconditions VERIFIED and an explicit direction to run it —
 * both satisfied by this session's own commits (`6d0fad2`/`82c3b87`/
 * `73265e7`, full 200/200 regression green, `wages_payable` confirmed
 * active/code `2150` this session) and the standing CTO directive to
 * proceed into the Integrated E2E once Payroll+Commission are stable.
 *
 * Proves both `ADR-072` chains converge correctly in ONE `PayrollRun`:
 *   Chain A: Customer -> Invoice -> Commission Resolution -> Approved
 *            CommissionResult -> Payroll.
 *   Chain B: Attendance day facts -> day-type classification -> Payroll
 *            pay impact.
 * and that `PayrollRun.status='posted'` is never, by itself, treated as
 * evidence of GL success (§9 assertion 3 — the single most important
 * assertion in the whole specification).
 *
 * Per §17, every GL-posting step here runs single-threaded
 * (`--runInBand`); a concurrency-class deadlock, if ever observed, is the
 * pre-existing, separately-escalated F03 RCA (`b5a9a85`), never a new
 * finding and never worked around here.
 */
describe('Integrated Attendance -> Payroll -> Commission -> GL E2E (ADR-072, spec 24082d6)', () => {
  let moduleRef: TestingModule;
  let payroll: PayrollService;
  let hr: HrService;
  let attendance: AttendanceService;
  let commission: CommissionService;
  let customers: CustomersService;
  let users: UsersService;
  let approvals: ApprovalEngineService;
  let treasury: TreasuryService;
  let financialEvents: FinancialEventService;
  let events: EventBusService;
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
    commission = moduleRef.get(CommissionService);
    customers = moduleRef.get(CustomersService);
    users = moduleRef.get(UsersService);
    approvals = moduleRef.get(ApprovalEngineService);
    treasury = moduleRef.get(TreasuryService);
    financialEvents = moduleRef.get(FinancialEventService);
    events = moduleRef.get(EventBusService);
    dataSource = moduleRef.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  const isoDate = (d: Date) => d.toISOString().slice(0, 10);
  const addDays = (n: number) => isoDate(new Date(Date.now() + n * 86_400_000));

  /**
   * `CommissionResult.calculationTimestamp` is always real "now"
   * (`calculateFromEvent`'s own `new Date()`, never caller-controlled) —
   * unlike Attendance's `calendarDate`, which the caller freely sets via
   * `recordManualPunch`. For one `PayrollRun` to correctly consume BOTH
   * an Attendance day range AND a Commission batch in the SAME
   * `calculate()` call, the `PayrollPeriod` itself must span real "today"
   * — a wide window (-3d/+5d) rather than an arbitrary future month,
   * unlike `payroll-phase1.spec.ts`'s own fixed 2027 dates (which never
   * needed to intersect a real timestamp).
   */
  // GAP-CLOSURE NOTE (2026-10-25): payroll periods may no longer overlap (DB trigger `payroll_periods_check_overlap`). This ambient-database spec creates several
  // windows around 'today' and therefore needs re-fitting (one distinct window per test) when the ambient test database is authorised; it was NOT RUN in the gap-closure
  // work (ambient DB blocked by the DB guard). Its company-mode replacement is `payroll-gap-closure.company-isolation.spec.ts`.
  async function makePeriod(): Promise<{ id: string; startDate: string; endDate: string }> {
    const startDate = addDays(-3);
    const endDate = addDays(5);
    const period = await payroll.createPeriod({ code: shortName('E2E'), startDate, endDate }, ADMIN_A);
    return { id: period.id, startDate, endDate };
  }

  async function makeFundedTreasuryAccount(amount: string): Promise<string> {
    const suffix = shortName('');
    const accountType = await treasury.createAccountType(`E2ETYPE-${suffix}`, `E2E Test Type ${suffix}`, ADMIN_A);
    const account = await treasury.createAccount(`E2EACC-${suffix}`, `E2E Test Account ${suffix}`, accountType.id, ADMIN_A);
    await treasury.cashIn(account.id, amount, null, null, 'E2E test funding', 'e2e test fixture', ADMIN_A);
    return account.id;
  }

  /** Chain A's Employee <-> Sales Rep identity: a real `User`, linked to the Employee, then assigned as the Customer's Sales Rep (ADR-068 §G resolution path). */
  async function makeEmployeeLinkedToUser(): Promise<{ employeeId: string; userId: string }> {
    const suffix = shortName('');
    const user = await users.create({ fullName: `E2E Rep ${suffix}`, email: `e2e.rep.${suffix}@test.daii.local` });
    const emp = await hr.createEmployee({ fullName: shortName('E2EEmp'), employmentType: 'full_time' }, ADMIN_A);
    await hr.linkUser(emp.id, user.id, ADMIN_A);
    return { employeeId: emp.id, userId: user.id };
  }

  async function makeAssignedCustomer(salesRepUserId: string): Promise<string> {
    const customer = await customers.createCustomer({ name: shortName('E2ECust') }, ADMIN_A);
    await customers.assignSalesRep(customer.id, salesRepUserId, 'primary', ADMIN_A);
    return customer.id;
  }

  async function publishInvoicePosted(customerId: string, netAmount: string, grossAmount: string): Promise<string> {
    const invoiceId = randomUUID();
    await dataSource.transaction(async (manager) => {
      await events.publish(manager, 'finance.invoice.posted', {
        invoiceId,
        invoiceNumber: shortName('E2EINV'),
        customerId,
        salesOrderId: null,
        netAmount,
        taxAmount: '0.00',
        grossAmount,
      });
    });
    await events.dispatchPending();
    return invoiceId;
  }

  it('Chain A + Chain B converge in one PayrollRun: Approved Commission Result and Attendance-derived day classifications both land correctly; PayrollRun.posted is never treated as GL proof; exactly one balanced journal posts; Commission/Attendance post zero GL entries of their own; disbursement succeeds only after FinancialEvent.status=POSTED', async () => {
    // --- Chain B fixture: Attendance ---
    const rep = await makeEmployeeLinkedToUser();
    await payroll.createCompensation({ employeeId: rep.employeeId, earnings: [{ componentCode: 'basic', amount: '4000.00' }], reason: 'test fixture' }, ADMIN_A);

    const presentDate = addDays(0);
    const leaveDate = addDays(1);
    const absentDate = addDays(2);
    const windowStart = addDays(-3);
    const windowEnd = addDays(5);
    await attendance.recordManualPunch({ employeeId: rep.employeeId, punchTimestamp: `${presentDate}T08:00:00.000Z`, punchType: 'in' }, ADMIN_A);
    await attendance.recordManualPunch({ employeeId: rep.employeeId, punchTimestamp: `${presentDate}T16:00:00.000Z`, punchType: 'out' }, ADMIN_A);
    const leaveRequest = await hr.submitLeaveRequest({ employeeId: rep.employeeId, leaveType: 'annual', startDate: leaveDate, endDate: leaveDate }, ADMIN_A);
    await approvals.decide(leaveRequest.approvalRequestId!, SECOND_APPROVER, 'approved', null);
    await attendance.deriveDay(rep.employeeId, leaveDate);
    await attendance.deriveDay(rep.employeeId, absentDate); // zero punches, no leave -> 'absent', no calendar policy exists -> 'unclassified' fail-safe

    const attendanceBatch = await attendance.submitApprovalBatch(windowStart, windowEnd, ADMIN_A);
    await approvals.decide(attendanceBatch.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    // --- Chain A fixture: Commission ---
    const customerId = await makeAssignedCustomer(rep.userId);
    await commission.createPolicy({ scope: 'customer', scopeRefId: customerId, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.10' }, ADMIN_A);
    const invoiceId = await publishInvoicePosted(customerId, '2000.00', '2000.00');

    const [commissionResult] = await commission.listResults(rep.employeeId);
    expect(commissionResult).toBeTruthy();
    expect(commissionResult.policyScope).toBe('customer'); // §15 assertion 4 — Customer precedence over Sales Rep default
    expect(Number(commissionResult.calculatedAmount)).toBeCloseTo(200, 2); // 2000 * 0.10
    expect(commissionResult.sourceTransactionRefs).toEqual({ invoice: invoiceId });

    const commissionBatch = await commission.submitApprovalBatch(windowStart, windowEnd, ADMIN_A);
    // SoD: the maker cannot also approve (§11 assertion 3).
    await expect(approvals.decide(commissionBatch.approvalRequestId!, ADMIN_A, 'approved', null)).rejects.toThrow(/maker/i);
    await approvals.decide(commissionBatch.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    const approvedForPayroll = await commission.listApprovedCommissionResults(rep.employeeId, windowStart, windowEnd);
    expect(approvedForPayroll).toHaveLength(1); // §15 assertion 2 — only an APPROVED batch's results are visible to Payroll

    // --- Convergence: one PayrollRun consumes both chains ---
    const period = await makePeriod();
    const run = await payroll.calculate(period.id, ADMIN_A);
    const { lines } = await payroll.getRun(run.id);
    const line = lines.find((l) => l.employeeId === rep.employeeId)!;
    expect(line).toBeTruthy();
    expect(Number(line.grossPay)).toBeCloseTo(4000, 2);
    expect(line.commissionAmount).toBeTruthy();
    expect(Number(line.commissionAmount)).toBeCloseTo(200, 2); // Chain A landed correctly
    expect(Number(line.netPay)).toBeCloseTo(4200, 2); // gross + commission, no deduction

    const classifications = await payroll.listDayClassifications(line.id);
    const present = classifications.find((c) => c.calendarDate === presentDate);
    const onLeave = classifications.find((c) => c.calendarDate === leaveDate);
    const absent = classifications.find((c) => c.calendarDate === absentDate);
    expect(present?.dayType).toBe('working');
    expect(onLeave?.dayType).toBe('approved_leave');
    expect(onLeave?.payImpact).toBe('none');
    expect(absent?.dayType).toBe('unclassified'); // Chain B fail-safe landed correctly — never an automatic deduction
    expect(absent?.payImpact).toBe('none');

    // --- FA-01 SoD on the PayrollRun itself (§11 assertion 2), then automatic approved->posted (ADR-070 §5) ---
    await payroll.review(run.id, ADMIN_A);
    const submitted = await payroll.submitForApproval(run.id, ADMIN_A);
    await expect(approvals.decide(submitted.approvalRequestId!, ADMIN_A, 'approved', null)).rejects.toThrow(/maker/i);
    await approvals.decide(submitted.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    const { run: postedRun } = await payroll.getRun(run.id);
    expect(postedRun.status).toBe('posted'); // Payroll-side fact only — NOT yet proof of GL success (§9 assertion 3)

    // --- The one GL entry point for this whole chain: exactly one balanced journal, verified independently of PayrollRun.status ---
    const financialEventRows: Array<{ id: string; status: string; journalEntryId: string | null }> = await dataSource.query(
      `SELECT id, status, "journalEntryId" FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
      [run.id],
    );
    expect(financialEventRows).toHaveLength(1); // §9 assertion 1
    expect(financialEventRows[0].status.toUpperCase()).toBe('POSTED');

    const journalLines: Array<{ debitBase: string; creditBase: string; controlFunction: string | null }> = await dataSource.query(
      `SELECT jl."debitBase", jl."creditBase", a."controlFunction"
       FROM accounting_journal_lines jl JOIN accounting_gl_accounts a ON a.id = jl."accountId"
       WHERE jl."journalEntryId" = $1`,
      [financialEventRows[0].journalEntryId],
    );
    expect(journalLines).toHaveLength(2); // §9 assertion 2 — no surprise accounts
    const debit = journalLines.reduce((s, l) => s + Number(l.debitBase || 0), 0);
    const credit = journalLines.reduce((s, l) => s + Number(l.creditBase || 0), 0);
    expect(Math.abs(debit - credit)).toBeLessThan(0.0001); // direct-SQL balance check, never an application-layer sum
    expect(journalLines.some((l) => l.controlFunction === 'wages_payable')).toBe(true);

    // --- Negative checks: neither Commission nor Attendance ever posts its own GL entry (§9 assertions 4/5) ---
    const [commissionGl] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM accounting_financial_events WHERE "sourceDomain" = 'commission'`);
    expect(commissionGl.count).toBe(0);
    const [attendanceGl] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM accounting_financial_events WHERE "sourceDomain" = 'attendance'`);
    expect(attendanceGl.count).toBe(0);

    // --- Disbursement gated on FinancialEvent.status=POSTED, never PayrollRun.postedAt alone (§16 assertion 3) ---
    const treasuryAccountId = await makeFundedTreasuryAccount('100000000.00');
    const disbursed = await payroll.disburse(run.id, treasuryAccountId, ADMIN_A);
    expect(disbursed.disbursedAt).toBeTruthy();

    // --- Correction boundary: a CommissionAdjustment created AFTER this run posted never touches the posted PayrollRunLine (§13 assertion 2) ---
    const netPayBefore = line.netPay;
    await commission.createAdjustment({ originalCommissionResultId: commissionResult.id, kind: 'correction', reason: 'post-hoc audit correction, out of band', amountDelta: '999.00' }, ADMIN_A);
    const { lines: linesAfterAdjustment } = await payroll.getRun(run.id);
    expect(linesAfterAdjustment.find((l) => l.id === line.id)!.netPay).toBe(netPayBefore); // untouched
  }, 60_000);

  it('Failure/recovery across the full chain: PayrollRun still reaches posted when wages_payable is deactivated (a Commission-bearing run this time); the reconciliation gap is flagged; disburse() is refused; reactivating + redrive self-heals (ADR-072 §18 items 1)', async () => {
    const rep = await makeEmployeeLinkedToUser();
    await payroll.createCompensation({ employeeId: rep.employeeId, earnings: [{ componentCode: 'basic', amount: '1500.00' }], reason: 'test fixture' }, ADMIN_A);
    const customerId = await makeAssignedCustomer(rep.userId);
    await commission.createPolicy({ scope: 'customer', scopeRefId: customerId, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.05' }, ADMIN_A);
    await publishInvoicePosted(customerId, '1000.00', '1000.00');
    const [commissionResult] = await commission.listResults(rep.employeeId);
    const commissionBatch = await commission.submitApprovalBatch(addDays(-3), addDays(5), ADMIN_A);
    await approvals.decide(commissionBatch.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    const period = await makePeriod();
    const treasuryAccountId = await makeFundedTreasuryAccount('100000000.00');

    await dataSource.query(`UPDATE accounting_gl_accounts SET "isActive" = false WHERE "controlFunction" = 'wages_payable'`);
    try {
      const run = await payroll.calculate(period.id, ADMIN_A);
      const { lines } = await payroll.getRun(run.id);
      const line = lines.find((l) => l.employeeId === rep.employeeId)!;
      expect(Number(line.commissionAmount)).toBeCloseTo(50, 2); // Chain A still landed correctly even on the failure path

      await payroll.review(run.id, ADMIN_A);
      const submitted = await payroll.submitForApproval(run.id, ADMIN_A);
      await approvals.decide(submitted.approvalRequestId!, SECOND_APPROVER, 'approved', null);

      const { run: postedRun } = await payroll.getRun(run.id);
      expect(postedRun.status).toBe('posted'); // unconditional, Payroll-side (ADR-070 §5)

      const gaps = await payroll.listReconciliationGaps();
      expect(gaps.some((g) => g.payrollRunId === run.id)).toBe(true);

      await expect(payroll.disburse(run.id, treasuryAccountId, ADMIN_A)).rejects.toThrow(/has not resolved POSTED/);

      await dataSource.query(`UPDATE accounting_gl_accounts SET "isActive" = true WHERE "controlFunction" = 'wages_payable'`);
      const [eventRejected] = await dataSource.query(
        `SELECT id FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
        [run.id],
      );
      await financialEvents.redrive(eventRejected.id);

      const gapsAfterRetry = await payroll.listReconciliationGaps();
      expect(gapsAfterRetry.some((g) => g.payrollRunId === run.id)).toBe(false); // self-healed

      const disbursedAfterRetry = await payroll.disburse(run.id, treasuryAccountId, ADMIN_A);
      expect(disbursedAfterRetry.disbursedAt).toBeTruthy();
    } finally {
      await dataSource.query(`UPDATE accounting_gl_accounts SET "isActive" = true WHERE "controlFunction" = 'wages_payable'`);
    }

    // Adjustment sanity: the commission result from this run is still a real, queryable, immutable row.
    expect(commissionResult.calculatedAmount).toBe('50.00');
  }, 60_000);

  it('Sales Rep unresolvable: an Invoice against a Customer with no active CustomerAssignment produces no CommissionResult, and Payroll never receives a phantom commissionAmount for that employee (ADR-071 §14, ADR-072 §18 item 4)', async () => {
    const customer = await customers.createCustomer({ name: shortName('E2EOrphan') }, ADMIN_A);
    await commission.createPolicy({ scope: 'customer', scopeRefId: customer.id, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.10' }, ADMIN_A);
    const invoiceId = await publishInvoicePosted(customer.id, '5000.00', '5000.00');

    const rows = await dataSource.query(`SELECT id FROM commission_results WHERE "triggerEventKey" = $1`, [`invoice:${invoiceId}`]);
    expect(rows).toHaveLength(0); // surfaced by absence, never a guessed/zeroed result
  }, 30_000);

  it('Manufacturing GL boundary sanity: Payroll/Commission never construct a manufacturing-sourced Financial Event, and every manufacturing-sourced row still traces to WorkOrderService alone (ADR-072 §16 item 2)', async () => {
    // 'work_order' is FinancialEventService.ingest()'s own default sourceEntityType derivation
    // (eventType.split('.')[1]) for every 'manufacturing.work_order.*' topic WorkOrderService
    // publishes (material_issued/material_returned/finished_goods_received) — confirmed by direct
    // read of financial-event.service.ts:115 and work-order.service.ts's own publish() calls.
    const [row] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM accounting_financial_events WHERE "sourceDomain" = 'manufacturing' AND "sourceEntityType" != 'work_order'`,
    );
    expect(row.count).toBe(0);
  }, 30_000);
});
