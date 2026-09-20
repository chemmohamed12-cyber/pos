import { ConflictException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { FINANCE_TREASURY_CONTRACT, FinanceTreasuryContract } from '../../../foundation/module-registry/contracts/finance.contract';
import { PayrollPeriod } from '../infrastructure/payroll-period.entity';
import { PayrollCompensation } from '../infrastructure/payroll-compensation.entity';
import { PayrollEarningLine } from '../infrastructure/payroll-earning-line.entity';
import { PayrollRun } from '../infrastructure/payroll-run.entity';
import { PayrollRunLine } from '../infrastructure/payroll-run-line.entity';
import { PayrollAttendanceDayClassification } from '../infrastructure/payroll-attendance-day-classification.entity';
import { PayrollDeductionLine } from '../infrastructure/payroll-deduction-line.entity';
import { PayrollAdjustment } from '../infrastructure/payroll-adjustment.entity';
import { PAYROLL_RUN_PROCESS_KEY, PayrollAdjustmentKind, PayrollDayPayImpact, PayrollDayType } from '../domain/payroll-run-status';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { HrService } from '../../hr/application/hr.service';
import { AttendanceService } from '../../attendance/application/attendance.service';

const APPROVAL_TYPE = 'payroll.run_approval';
const APPROVER_NODE = 'payroll.run.approve';
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const RUN_ENTITY_TYPE = 'PayrollRun';

/** ADR-070 §5 — driven by `ProcessEngineService`, the same engine `FiscalPeriod` already uses. `approved -> posted` is automatic (ADR-070 §5's own correction), fired from the FA-01 approval event handler below, never a direct caller transition. */
export const PAYROLL_RUN_PROCESS: ProcessDefinition = {
  key: PAYROLL_RUN_PROCESS_KEY,
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'calculated', action: 'calculate' },
    { from: 'calculated', to: 'calculated', action: 'recalculate' }, // idempotent recompute while still draft-of-calculation
    { from: 'calculated', to: 'reviewed', action: 'review' },
    { from: 'reviewed', to: 'approved', action: 'approve' },
    { from: 'approved', to: 'posted', action: 'post' },
  ],
};

export interface CreatePeriodInput {
  code: string;
  startDate: string;
  endDate: string;
}

export interface EarningLineInput {
  componentCode: string;
  amount: string;
}

export interface CreateCompensationInput {
  employeeId: string;
  earnings: EarningLineInput[];
}

export interface CreateAdjustmentInput {
  originalPayrollRunLineId: string;
  kind: PayrollAdjustmentKind;
  reason: string;
  amountDelta: string;
}

/**
 * ADR-070 — Payroll Phase 1 application service. Implements the ratified
 * `ADR-067` decisions exactly: componentized Earnings (§B), independent
 * day-type determination with the `unclassified`/no-deduction fail-safe
 * (§C — Holiday Calendar remains an open `ADR-053 §16` escalation, never
 * invented here), no overtime/tax/insurance computation (§D/§E, both
 * genuinely unresolved, not simulated), and GL posting exclusively
 * through the existing Financial Event architecture (§K).
 */
@Injectable()
export class PayrollService implements OnModuleInit {
  constructor(
    @InjectRepository(PayrollPeriod) private readonly periods: Repository<PayrollPeriod>,
    @InjectRepository(PayrollCompensation) private readonly compensations: Repository<PayrollCompensation>,
    @InjectRepository(PayrollEarningLine) private readonly earningLines: Repository<PayrollEarningLine>,
    @InjectRepository(PayrollRun) private readonly runs: Repository<PayrollRun>,
    @InjectRepository(PayrollRunLine) private readonly runLines: Repository<PayrollRunLine>,
    @InjectRepository(PayrollAttendanceDayClassification) private readonly dayClassifications: Repository<PayrollAttendanceDayClassification>,
    @InjectRepository(PayrollDeductionLine) private readonly deductionLines: Repository<PayrollDeductionLine>,
    @InjectRepository(PayrollAdjustment) private readonly adjustments: Repository<PayrollAdjustment>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly approvals: ApprovalEngineService,
    private readonly processEngine: ProcessEngineService,
    private readonly numbering: NumberingService,
    private readonly hr: HrService,
    private readonly attendance: AttendanceService,
    @Inject(FINANCE_TREASURY_CONTRACT) private readonly treasury: FinanceTreasuryContract,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.numbering.registerDocumentType('payroll_run', 'PR', true).catch(() => undefined);
    await this.numbering.registerDocumentType('payroll_compensation', 'PC', true).catch(() => undefined);

    await this.approvals.registerRequestType(APPROVAL_TYPE, 'action.payroll_submit_approval');
    await this.approvals
      .upsertMatrixRule({ requestTypeCode: APPROVAL_TYPE, minApprovers: 1, requiredPermissionNode: APPROVER_NODE, valueThreshold: null, orgUnitId: null }, SYSTEM_ACTOR_ID)
      .catch(() => undefined);

    this.events.subscribe('approval.request.approved', async (payload) => {
      await this.onApprovalApproved(payload as Record<string, unknown>);
    });
  }

  // ---------------------------------------------------------------------------
  // Periods — ADR-070 §A. Monthly in Phase 1; the model itself carries no
  // frequency assumption beyond what the caller supplies.
  // ---------------------------------------------------------------------------

  async createPeriod(input: CreatePeriodInput, actorUserId: string): Promise<PayrollPeriod> {
    if (input.startDate > input.endDate) throw new ConflictException('startDate must be on or before endDate.');
    const saved = await this.periods.save(this.periods.create({ code: input.code, startDate: input.startDate, endDate: input.endDate, status: 'open' }));
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'payroll.period.created',
      resource: 'payroll_period',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { code: input.code, startDate: input.startDate, endDate: input.endDate },
    });
    return saved;
  }

  async listPeriods(): Promise<PayrollPeriod[]> {
    return this.periods.find({ order: { startDate: 'DESC' } });
  }

  // ---------------------------------------------------------------------------
  // Compensation — ADR-070 §B. Effective-dated; a change never rewrites a
  // prior period's history. Componentized Earnings, never a single figure.
  // ---------------------------------------------------------------------------

  async createCompensation(input: CreateCompensationInput, actorUserId: string): Promise<PayrollCompensation> {
    await this.hr.getEmployee(input.employeeId); // throws NotFoundException if the employee does not exist
    if (input.earnings.length === 0) throw new ConflictException('At least one earning line is required.');
    for (const line of input.earnings) {
      if (!(Number(line.amount) > 0)) throw new ConflictException(`Earning line "${line.componentCode}" must have a positive amount.`);
    }

    return this.dataSource.transaction(async (manager) => {
      const existingActive = await manager.getRepository(PayrollCompensation).findOne({ where: { employeeId: input.employeeId, effectiveTo: IsNull() } });
      const now = new Date();
      if (existingActive) {
        existingActive.effectiveTo = now;
        existingActive.status = 'superseded';
        await manager.getRepository(PayrollCompensation).save(existingActive);
      }

      const saved = await manager.getRepository(PayrollCompensation).save(
        manager.getRepository(PayrollCompensation).create({ employeeId: input.employeeId, effectiveFrom: now, effectiveTo: null, status: 'active', createdByUserId: actorUserId }),
      );
      for (const line of input.earnings) {
        await manager.getRepository(PayrollEarningLine).save(manager.getRepository(PayrollEarningLine).create({ compensationId: saved.id, componentCode: line.componentCode, amount: line.amount }));
      }

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'payroll.compensation.created',
          resource: 'payroll_compensation',
          resourceId: saved.id,
          result: 'success',
          correlationId: null,
          after: { employeeId: input.employeeId, earnings: input.earnings },
        },
        manager,
      );
      return saved;
    });
  }

  async listCompensations(employeeId?: string): Promise<PayrollCompensation[]> {
    return this.compensations.find({ where: employeeId ? { employeeId } : {}, order: { createdAt: 'DESC' } });
  }

  private async getActiveCompensationWithLines(employeeId: string): Promise<{ compensation: PayrollCompensation; lines: PayrollEarningLine[] } | null> {
    const compensation = await this.compensations.findOne({ where: { employeeId, effectiveTo: IsNull() } });
    if (!compensation) return null;
    const lines = await this.earningLines.find({ where: { compensationId: compensation.id } });
    return { compensation, lines };
  }

  // ---------------------------------------------------------------------------
  // Day-type determination — ADR-070 §9/§C, binding Payroll control, not UI
  // behavior. `AttendanceDay.status = 'absent'` never alone implies a
  // deduction. No `PayrollCalendarPolicy` source exists yet (Holiday
  // Calendar remains an open ADR-053 §16 escalation, ADR-067 §C/ADR-070
  // §21) — every 'absent' day therefore resolves to the fail-safe:
  // `unclassified`/`none`, never `deduction`. This is not a shortcut; it is
  // the documented, correct behavior until that policy is supplied.
  // ---------------------------------------------------------------------------

  classifyDay(attendanceStatus: 'present' | 'absent' | 'on_leave' | 'missing_punch'): { dayType: PayrollDayType; payImpact: PayrollDayPayImpact } {
    switch (attendanceStatus) {
      case 'on_leave':
        return { dayType: 'approved_leave', payImpact: 'none' };
      case 'present':
        return { dayType: 'working', payImpact: 'none' };
      case 'missing_punch':
        // Phase 1: incomplete punch data is a data-quality flag, never an automatic deduction —
        // no policy authorizes deducting pay for a missing punch alone.
        return { dayType: 'working', payImpact: 'none' };
      case 'absent':
        // Fail-safe (ADR-070 §21 escalation): no Holiday Calendar/weekend-pattern source exists
        // yet, so Payroll cannot distinguish a genuine working-day absence from a weekend/holiday.
        // Absence of a calendar answer defaults to "do not deduct," never "assume working day."
        return { dayType: 'unclassified', payImpact: 'none' };
    }
  }

  // ---------------------------------------------------------------------------
  // PayrollRun — ADR-070 §5/§9/§13. calculate() is safe to re-invoke while
  // the run is still 'draft' (idempotent recompute); it is a no-op (in
  // fact, rejected) once the run has left 'draft'.
  // ---------------------------------------------------------------------------

  async calculate(payrollPeriodId: string, actorUserId: string): Promise<PayrollRun> {
    const period = await this.periods.findOne({ where: { id: payrollPeriodId } });
    if (!period) throw new NotFoundException(`Payroll period "${payrollPeriodId}" not found.`);

    let run = await this.runs.findOne({ where: { payrollPeriodId } });
    let isNew = false;
    if (!run) {
      const code = await this.numbering.getNextNumber('payroll_run');
      run = await this.runs.save(this.runs.create({ code, payrollPeriodId, status: 'draft', createdByUserId: actorUserId }));
      await this.processEngine.start(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, run.id);
      isNew = true;
    }

    const state = await this.processEngine.getState(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, run.id);
    if (state !== 'draft' && state !== 'calculated') {
      throw new ConflictException(`PayrollRun "${run.id}" is already "${state}" — recalculation requires a new run/period (ADR-070 §18, immutability).`);
    }

    // Idempotent recompute: discard prior draft lines for this still-uncommitted run (ADR-070 §12).
    const existingLines = await this.runLines.find({ where: { payrollRunId: run.id } });
    for (const line of existingLines) {
      await this.dayClassifications.delete({ payrollRunLineId: line.id });
      await this.deductionLines.delete({ payrollRunLineId: line.id });
    }
    if (existingLines.length > 0) await this.runLines.delete({ payrollRunId: run.id });

    // Population scope (ADR-067 §I): active, non-contractor employees only.
    const employees = await this.hr.listEmployees();
    const eligible = employees.filter((e) => e.status === 'active' && e.employmentType !== 'contractor');

    // Attendance facts via the read contract ADR-070 §9 specifies — approved batches overlapping
    // this period's date range, never raw attendance data.
    const batches = await this.attendance.listApprovalBatches();
    const relevantBatches = batches.filter((b) => b.status === 'approved' && b.periodStart <= period.endDate && b.periodEnd >= period.startDate);
    const daysByEmployee = new Map<string, Array<{ calendarDate: string; status: 'present' | 'absent' | 'on_leave' | 'missing_punch' }>>();
    for (const batch of relevantBatches) {
      const days = await this.attendance.listApprovedDaysByBatch(batch.id);
      for (const day of days) {
        const arr = daysByEmployee.get(day.employeeId) ?? [];
        arr.push({ calendarDate: day.calendarDate, status: day.status });
        daysByEmployee.set(day.employeeId, arr);
      }
    }

    const now = new Date();
    for (const emp of eligible) {
      const comp = await this.getActiveCompensationWithLines(emp.id);
      if (!comp) continue; // no active compensation configured — genuinely out of this run's scope, not an error

      const grossPay = comp.lines.reduce((sum, l) => sum + Number(l.amount), 0);
      // No system-derived attendance deduction is ever created in this Phase 1 slice — the
      // classification fail-safe above guarantees payImpact is never 'deduction' until a Holiday
      // Calendar policy exists, so there is no rate/formula to invent here.
      const totalDeductions = 0;
      const netPay = grossPay - totalDeductions;

      const line = await this.runLines.save(
        this.runLines.create({
          payrollRunId: run.id,
          employeeId: emp.id,
          compensationSnapshot: { compensationId: comp.compensation.id, earnings: comp.lines.map((l) => ({ componentCode: l.componentCode, amount: l.amount })) },
          grossPay: grossPay.toFixed(2),
          totalDeductions: totalDeductions.toFixed(2),
          netPay: netPay.toFixed(2),
          commissionAmount: null, // ADR-070 §J — reserved; Commission's read contract is not wired in this slice
          overtimeAmount: null, // ADR-067 §D — reserved extension point, not computed
          calculationTimestamp: now,
        }),
      );

      const employeeDays = (daysByEmployee.get(emp.id) ?? []).filter((d) => d.calendarDate >= period.startDate && d.calendarDate <= period.endDate);
      for (const day of employeeDays) {
        const { dayType, payImpact } = this.classifyDay(day.status);
        await this.dayClassifications.save(
          this.dayClassifications.create({ payrollRunLineId: line.id, calendarDate: day.calendarDate, attendanceStatus: day.status, dayType, payImpact }),
        );
      }
    }

    await this.processEngine.transition(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, run.id, isNew ? 'calculate' : 'recalculate', actorUserId);
    run.status = 'calculated';
    run.calculatedAt = now;
    await this.runs.save(run);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'payroll.run.calculated',
      resource: 'payroll_run',
      resourceId: run.id,
      result: 'success',
      correlationId: null,
      after: { payrollPeriodId, employeeCount: eligible.length },
    });
    return run;
  }

  async review(runId: string, actorUserId: string): Promise<PayrollRun> {
    const run = await this.runs.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException(`PayrollRun "${runId}" not found.`);
    await this.processEngine.transition(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, runId, 'review', actorUserId);
    run.status = 'reviewed';
    run.reviewedByUserId = actorUserId;
    run.reviewedAt = new Date();
    const saved = await this.runs.save(run);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'payroll.run.reviewed',
      resource: 'payroll_run',
      resourceId: runId,
      result: 'success',
      correlationId: null,
    });
    return saved;
  }

  /** FA-01 submission — the one human control point (ADR-070 §5/§10). `approved -> posted` is automatic afterward, not a second submission. */
  async submitForApproval(runId: string, actorUserId: string): Promise<PayrollRun> {
    const run = await this.runs.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException(`PayrollRun "${runId}" not found.`);
    const state = await this.processEngine.getState(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, runId);
    if (state !== 'reviewed') throw new ConflictException(`PayrollRun must be "reviewed" before FA-01 submission (current: "${state}").`);

    const lines = await this.runLines.find({ where: { payrollRunId: runId } });
    const totalNet = lines.reduce((sum, l) => sum + Number(l.netPay), 0);

    const approvalRequest = await this.approvals.submit({
      requestTypeCode: APPROVAL_TYPE,
      resourceType: RUN_ENTITY_TYPE,
      resourceId: runId,
      requestedAction: 'approve',
      payload: { payrollRunId: runId, employeeCount: lines.length, totalNet: totalNet.toFixed(2) },
      makerUserId: actorUserId,
    });
    run.approvalRequestId = approvalRequest.id;
    const saved = await this.runs.save(run);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'payroll.run.submitted',
      resource: 'payroll_run',
      resourceId: runId,
      result: 'success',
      correlationId: approvalRequest.id,
    });
    return saved;
  }

  /** Pure pass-through to the generic engine — same shape as every other FA-01 consumer's own `decide` (e.g. `AttendanceService.decide`). */
  async decide(requestId: string, approverUserId: string, decision: 'approved' | 'rejected', note?: string | null): Promise<unknown> {
    return this.approvals.decide(requestId, approverUserId, decision, note ?? null);
  }

  async listRuns(): Promise<PayrollRun[]> {
    return this.runs.find({ order: { createdAt: 'DESC' } });
  }

  async getRun(id: string): Promise<{ run: PayrollRun; lines: PayrollRunLine[] }> {
    const run = await this.runs.findOne({ where: { id } });
    if (!run) throw new NotFoundException(`PayrollRun "${id}" not found.`);
    const lines = await this.runLines.find({ where: { payrollRunId: id } });
    return { run, lines };
  }

  /**
   * The Frontend's own explicit three-state distinction requirement:
   * `PayrollRun.status`, `FinancialEvent.status`, and Treasury
   * disbursement are never the same state (`ADR-070 §6`). Returns `null`
   * when no `FinancialEvent` has landed yet (the run hasn't reached
   * `posted`, or the outbox hasn't dispatched it yet) — the UI must show
   * this as its own distinct "not yet posted" state, never blank/error.
   */
  async getFinancialEventStatus(runId: string): Promise<{ status: string; rejectionReason: string | null; journalEntryId: string | null } | null> {
    const [event]: Array<{ status: string; rejectionReason: string | null; journalEntryId: string | null }> = await this.dataSource.query(
      `SELECT status, "rejectionReason", "journalEntryId" FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
      [runId],
    );
    return event ?? null;
  }

  async listDayClassifications(payrollRunLineId: string): Promise<PayrollAttendanceDayClassification[]> {
    return this.dayClassifications.find({ where: { payrollRunLineId }, order: { calendarDate: 'ASC' } });
  }

  // ---------------------------------------------------------------------------
  // FA-01 subscriber — approved -> posted is automatic (ADR-070 §5's own
  // correction), never a second human action. Publishes the Financial
  // Event; does NOT wait for or assume GL posting succeeded (ADR-070 §6/§13).
  // ---------------------------------------------------------------------------

  private async onApprovalApproved(payload: Record<string, unknown>): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (requestTypeCode !== APPROVAL_TYPE) return;
    const resourceId = String(payload.resourceId ?? '');
    const run = await this.runs.findOne({ where: { id: resourceId } });
    if (!run || run.status === 'posted') return; // not found, or already applied — benign no-op

    const lines = await this.runLines.find({ where: { payrollRunId: run.id } });
    const totalGross = lines.reduce((sum, l) => sum + Number(l.grossPay), 0);
    const totalNet = lines.reduce((sum, l) => sum + Number(l.netPay), 0);

    await this.dataSource.transaction(async (manager) => {
      await this.processEngine.transition(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, run.id, 'approve', SYSTEM_ACTOR_ID, manager);
      await this.processEngine.transition(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, run.id, 'post', SYSTEM_ACTOR_ID, manager);

      run.status = 'posted';
      run.approvedAt = new Date();
      run.postedAt = new Date();
      await manager.getRepository(PayrollRun).save(run);

      // ADR-070 §13 — this is the ONE Payroll transaction: process transitions + the outbox row,
      // then COMMIT. GL Journal Posting happens later, in a separate transaction, when
      // EventBusService.dispatchPending() invokes the registered Financial Event handler.
      // `sourceEntityType`/`sourceEntityId` are explicit (not left to FinancialEventService's own
      // `eventType.split('.')[1]` default, which would resolve to 'run', not 'PayrollRun') — this
      // is the exact pair ADR-070 §6's reconciliation invariant and listReconciliationGaps() key on.
      await this.events.publish(manager, 'payroll.run.posted', {
        sourceEntityType: RUN_ENTITY_TYPE,
        sourceEntityId: run.id,
        payrollRunId: run.id,
        payrollPeriodId: run.payrollPeriodId,
        totalGross: totalGross.toFixed(2),
        totalNet: totalNet.toFixed(2),
        employeeCount: lines.length,
      });
    });

    // This handler is itself invoked from inside ApprovalEngineService.decide's own
    // dispatchPending() pass (approval-engine.service.ts:307) — the outbox row just published
    // above did not exist when that pass started, so it will not be drained by it. Same explicit
    // "the publisher dispatches" convention every other service in this codebase follows
    // (WorkOrderService, TreasuryService, InvoicesService, ...).
    await this.events.dispatchPending();

    await this.audit.record({
      actorUserId: SYSTEM_ACTOR_ID,
      organizationId: null,
      action: 'payroll.run.posted',
      resource: 'payroll_run',
      resourceId: run.id,
      result: 'success',
      correlationId: String(payload.approvalRequestId ?? ''),
      after: { totalGross: totalGross.toFixed(2), totalNet: totalNet.toFixed(2) },
    });
  }

  // ---------------------------------------------------------------------------
  // Reconciliation — ADR-070 §6/§15. The concrete, queryable detector for
  // "PayrollRun posted + GL not confirmed" — never assumed benign.
  // ---------------------------------------------------------------------------

  async listReconciliationGaps(): Promise<Array<{ payrollRunId: string; code: string }>> {
    const rows: Array<{ id: string; code: string }> = await this.dataSource.query(`
      SELECT pr.id, pr.code FROM payroll_runs pr
      LEFT JOIN accounting_financial_events fe
        ON fe."sourceEntityType" = 'PayrollRun' AND fe."sourceEntityId"::text = pr.id::text
      WHERE pr.status = 'posted'
        AND (fe.id IS NULL OR fe.status NOT IN ('POSTED'))
    `);
    return rows.map((r) => ({ payrollRunId: r.id, code: r.code }));
  }

  // ---------------------------------------------------------------------------
  // Disbursement — ADR-070 §9/§13. A separate, explicitly human-invoked
  // action, never automatic — mirrors the existing, already-proven
  // `SupplierPaymentService.recordPayment` precedent exactly (its own
  // dedicated controller endpoint, never auto-cascaded from GL posting).
  // Gated on `FinancialEvent.status = 'POSTED'`, never on
  // `PayrollRun.postedAt` alone (ADR-070 §6's invariant is precisely why
  // this check is mandatory).
  // ---------------------------------------------------------------------------

  async disburse(runId: string, treasuryAccountId: string, actorUserId: string): Promise<PayrollRun> {
    const run = await this.runs.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException(`PayrollRun "${runId}" not found.`);
    if (run.status !== 'posted') throw new ConflictException(`PayrollRun "${runId}" must be "posted" before disbursement (current: "${run.status}").`);
    if (run.disbursedAt) throw new ConflictException(`PayrollRun "${runId}" has already been disbursed.`);

    const [event]: Array<{ status: string }> = await this.dataSource.query(
      `SELECT status FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
      [runId],
    );
    if (!event || event.status.toUpperCase() !== 'POSTED') {
      throw new ConflictException(
        `PayrollRun "${runId}" cannot be disbursed — its Financial Event has not resolved POSTED (current: "${event?.status ?? 'none — not yet dispatched'}"). ADR-070 §9: disbursement never proceeds on PayrollRun.posted alone.`,
      );
    }

    const lines = await this.runLines.find({ where: { payrollRunId: runId } });

    await this.dataSource.transaction(async (manager) => {
      // Advisory lock + a fresh re-check inside the transaction — the same idempotency/
      // duplicate-disbursement guard shape SupplierPaymentService.recordPayment already proves.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payroll:disburse:${runId}`]);
      const fresh = await manager.getRepository(PayrollRun).findOne({ where: { id: runId } });
      if (fresh?.disbursedAt) throw new ConflictException(`PayrollRun "${runId}" has already been disbursed.`);

      for (const line of lines) {
        await this.treasury.cashOutForEmployee(treasuryAccountId, line.netPay, line.employeeId, runId, `Payroll ${run.code}`, 'payroll_disbursement', actorUserId, manager);
      }

      run.disbursedAt = new Date();
      await manager.getRepository(PayrollRun).save(run);
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'payroll.run.disbursed',
      resource: 'payroll_run',
      resourceId: runId,
      result: 'success',
      correlationId: null,
      after: { treasuryAccountId, employeeCount: lines.length, totalNet: lines.reduce((s, l) => s + Number(l.netPay), 0).toFixed(2) },
    });
    return run;
  }

  // ---------------------------------------------------------------------------
  // Correction — ADR-070 §18. No PayrollRunLine/PayrollDeductionLine row is
  // ever updated after its run is posted; only a new PayrollAdjustment row
  // may reference it.
  // ---------------------------------------------------------------------------

  async createAdjustment(input: CreateAdjustmentInput, actorUserId: string): Promise<PayrollAdjustment> {
    const line = await this.runLines.findOne({ where: { id: input.originalPayrollRunLineId } });
    if (!line) throw new NotFoundException(`PayrollRunLine "${input.originalPayrollRunLineId}" not found.`);

    const saved = await this.adjustments.save(
      this.adjustments.create({
        originalPayrollRunLineId: input.originalPayrollRunLineId,
        kind: input.kind,
        reason: input.reason,
        amountDelta: input.amountDelta,
        createdByUserId: actorUserId,
      }),
    );
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'payroll.adjustment.created',
      resource: 'payroll_adjustment',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { originalPayrollRunLineId: input.originalPayrollRunLineId, kind: input.kind, amountDelta: input.amountDelta, reason: input.reason },
    });
    return saved;
  }

  async listAdjustments(originalPayrollRunLineId?: string): Promise<PayrollAdjustment[]> {
    return this.adjustments.find({ where: originalPayrollRunLineId ? { originalPayrollRunLineId } : {}, order: { createdAt: 'DESC' } });
  }
}
