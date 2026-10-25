import { createHash } from 'crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { PayrollPeriod } from '../infrastructure/payroll-period.entity';
import { PayrollCompensation } from '../infrastructure/payroll-compensation.entity';
import { PayrollEarningLine } from '../infrastructure/payroll-earning-line.entity';
import { PayrollRun } from '../infrastructure/payroll-run.entity';
import { PayrollRunLine } from '../infrastructure/payroll-run-line.entity';
import { PayrollAttendanceDayClassification } from '../infrastructure/payroll-attendance-day-classification.entity';
import { PayrollDeductionLine } from '../infrastructure/payroll-deduction-line.entity';
import { PayrollAdjustment } from '../infrastructure/payroll-adjustment.entity';
import { PayrollInputConsumption } from '../infrastructure/payroll-input-consumption.entity';
import { PayrollRunStageActor } from '../infrastructure/payroll-run-stage-actor.entity';
import { PAYROLL_RUN_PROCESS_KEY, PayrollAdjustmentKind, PayrollDayPayImpact, PayrollDayType } from '../domain/payroll-run-status';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { runInTransaction } from '../../../foundation/transaction/run-in-transaction';
import { dec, isFiniteDecimalString, money, sumMoney } from '../../../foundation/money/decimal-money';
import { HrService } from '../../hr/application/hr.service';
import { AttendanceService } from '../../attendance/application/attendance.service';
import { CommissionService } from '../../commission/application/commission.service';
import { PayrollSodService, SYSTEM_ACTOR_ID } from './payroll-sod.service';
import { DetectedException, PayrollExceptionService } from './payroll-exception.service';
import { PayrollPayoutService, PayrollReconciliation } from './payroll-payout.service';

const APPROVAL_TYPE = 'payroll.run_approval';
const APPROVER_NODE = 'payroll.run.approve';
const RUN_ENTITY_TYPE = 'PayrollRun';

/**
 * ADR-070 §5 — driven by `ProcessEngineService`, the same engine `FiscalPeriod` already uses. `approved -> posted` is automatic (ADR-070 §5's own correction),
 * fired from the FA-01 approval event handler below, never a direct caller transition.
 * Addendum A-4/A-9: `recalculate` (ratified), `reject` (reviewed -> calculated, the explicit rejection path) and `supersede` (a newer revision replaces a run that was
 * never posted).
 */
export const PAYROLL_RUN_PROCESS: ProcessDefinition = {
  key: PAYROLL_RUN_PROCESS_KEY,
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'calculated', action: 'calculate' },
    { from: 'calculated', to: 'calculated', action: 'recalculate' },
    { from: 'calculated', to: 'reviewed', action: 'review' },
    { from: 'reviewed', to: 'calculated', action: 'reject' },
    { from: 'reviewed', to: 'approved', action: 'approve' },
    { from: 'approved', to: 'posted', action: 'post' },
    { from: 'draft', to: 'superseded', action: 'supersede' },
    { from: 'calculated', to: 'superseded', action: 'supersede' },
    { from: 'reviewed', to: 'superseded', action: 'supersede' },
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
  /** YYYY-MM-DD; defaults to today (UTC). Must be later than the start of the compensation it replaces. */
  effectiveFrom?: string;
  /** Why the compensation changes — required. */
  reason: string;
}

export interface CreateAdjustmentInput {
  originalPayrollRunLineId: string;
  kind: PayrollAdjustmentKind;
  reason: string;
  amountDelta: string;
}

type AttendanceStatus = 'present' | 'absent' | 'on_leave' | 'missing_punch';

interface EffectiveCompensation {
  compensation: PayrollCompensation;
  lines: PayrollEarningLine[];
  /** A later compensation of the same employee starts inside the period (no proration rule exists — flagged as an exception). */
  changeInPeriod: PayrollCompensation | null;
}

interface GatheredInputs {
  employees: Array<{ id: string; status: string; employmentType: string | null; hireDate: string | null; terminationDate: string | null }>;
  compensations: Map<string, EffectiveCompensation>;
  daysByEmployee: Map<string, Array<{ calendarDate: string; status: AttendanceStatus }>>;
  batchIds: string[];
  commissionResults: Array<{ id: string; employeeId: string; amount: string; attributionDate: string; policyId: string }>;
  commissionAdjustments: Array<{ id: string; employeeId: string; amount: string; originalResultId: string; kind: string; attributionDate: string }>;
  payrollAdjustments: Array<{ id: string; employeeId: string; amount: string; originalLineId: string; kind: string }>;
  accountingReady: { wagesPayable: boolean; expense: boolean };
}

const EXPENSE_ACCOUNT_CODE = '5201';

/**
 * ADR-070 — Payroll application service (gap closure per the CTO mandate of 2026-10-25; contract = ADR-070/071/072 Addendum 1, working policy baseline).
 *
 * Implements ADR-067 exactly: componentized Earnings (§B) selected by the compensation EFFECTIVE for the period, day-type determination with the
 * `unclassified`/no-deduction fail-safe (§C — the Holiday Calendar stays an open escalation), no overtime/tax/insurance computation (§D/§E), GL posting only through
 * the Financial Event architecture (§K), and corrections that never rewrite posted history (§M).
 * All money is exact-decimal; every employee who is not paid, and every fact that changes the basis of a payment, becomes an exception (no silent skip).
 */
@Injectable()
export class PayrollService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly approvals: ApprovalEngineService,
    private readonly processEngine: ProcessEngineService,
    private readonly numbering: NumberingService,
    private readonly hr: HrService,
    private readonly attendance: AttendanceService,
    private readonly commission: CommissionService,
    private readonly sod: PayrollSodService,
    private readonly exceptions: PayrollExceptionService,
    private readonly payouts: PayrollPayoutService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  /** Area 21: repositories bound to the caller's connection — the Company's own when a Company `manager` is passed, the ambient one otherwise. */
  private repos(manager?: EntityManager) {
    const em = this.em(manager);
    return {
      periods: em.getRepository(PayrollPeriod),
      compensations: em.getRepository(PayrollCompensation),
      earningLines: em.getRepository(PayrollEarningLine),
      runs: em.getRepository(PayrollRun),
      runLines: em.getRepository(PayrollRunLine),
      dayClassifications: em.getRepository(PayrollAttendanceDayClassification),
      deductionLines: em.getRepository(PayrollDeductionLine),
      adjustments: em.getRepository(PayrollAdjustment),
    };
  }

  /** The payroll document types are registered at boot in the ambient DB; a Company's own database gets them on first use (idempotent). */
  private async ensureNumbering(manager?: EntityManager): Promise<void> {
    if (!manager) return;
    await this.numbering.registerDocumentType('payroll_run', 'PR', true, manager);
    await this.numbering.registerDocumentType('payroll_compensation', 'PC', true, manager);
  }

  async onModuleInit(): Promise<void> {
    await this.numbering.registerDocumentType('payroll_run', 'PR', true).catch(() => undefined);
    await this.numbering.registerDocumentType('payroll_compensation', 'PC', true).catch(() => undefined);

    await this.approvals.registerRequestType(APPROVAL_TYPE, 'action.payroll_submit_approval');
    await this.approvals
      .upsertMatrixRule({ requestTypeCode: APPROVAL_TYPE, minApprovers: 1, requiredPermissionNode: APPROVER_NODE, valueThreshold: null, orgUnitId: null }, SYSTEM_ACTOR_ID)
      .catch(() => undefined);

    this.events.subscribe(
      'approval.request.approved',
      async (payload, ctx) => {
        await this.onApprovalApproved(payload as Record<string, unknown>, ctx.manager ?? undefined);
      },
      { scope: 'company' },
    );
    this.events.subscribe(
      'approval.request.rejected',
      async (payload, ctx) => {
        await this.onApprovalRejected(payload as Record<string, unknown>, ctx.manager ?? undefined);
      },
      { scope: 'company' },
    );
  }

  // ---------------------------------------------------------------------------
  // Periods — ADR-067 §A/§N. Monthly in Phase 1; no overlap (DB trigger + friendly pre-check); explicit close.
  // ---------------------------------------------------------------------------

  async createPeriod(input: CreatePeriodInput, actorUserId: string, manager?: EntityManager): Promise<PayrollPeriod> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) throw new ConflictException('startDate and endDate must be YYYY-MM-DD dates.');
    if (input.startDate > input.endDate) throw new ConflictException('startDate must be on or before endDate.');
    const overlap: Array<{ code: string }> = await this.em(manager).query(
      `SELECT code FROM payroll_periods WHERE daterange("startDate", "endDate", '[]') && daterange($1::date, $2::date, '[]') LIMIT 1`,
      [input.startDate, input.endDate],
    );
    if (overlap.length > 0) throw new ConflictException(`The period overlaps the existing payroll period "${overlap[0].code}".`);
    let saved: PayrollPeriod;
    try {
      saved = await this.repos(manager).periods.save(this.repos(manager).periods.create({ code: input.code, startDate: input.startDate, endDate: input.endDate, status: 'open' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/overlaps an existing payroll period/i.test(msg)) throw new ConflictException('The period overlaps an existing payroll period.');
      if (/UQ_payroll_periods_code|duplicate key/i.test(msg)) throw new ConflictException(`A payroll period with code "${input.code}" already exists.`);
      throw err;
    }
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'payroll.period.created',
      resource: 'payroll_period',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { code: input.code, startDate: input.startDate, endDate: input.endDate },
    }, manager);
    return saved;
  }

  async listPeriods(manager?: EntityManager): Promise<PayrollPeriod[]> {
    return this.repos(manager).periods.find({ order: { startDate: 'DESC' } });
  }

  /**
   * Addendum A-9 — `open -> closed`. Allowed only when the period's regular run is `posted`, no supplementary run is still open, and nothing blocks. A closed
   * period accepts no ordinary recalculation; a post-close correction is a supplementary revision (`calculateSupplementary`) or an adjustment input of the next run.
   */
  async closePeriod(periodId: string, actorUserId: string, manager?: EntityManager): Promise<PayrollPeriod> {
    return runInTransaction(this.dataSource, manager, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payroll:period:${periodId}`]);
      const period = await tx.getRepository(PayrollPeriod).findOne({ where: { id: periodId } });
      if (!period) throw new NotFoundException(`Payroll period "${periodId}" not found.`);
      if (period.status === 'closed') throw new ConflictException(`Payroll period "${period.code}" is already closed.`);
      const runs = await tx.getRepository(PayrollRun).find({ where: { payrollPeriodId: periodId } });
      const regular = runs.find((r) => r.kind === 'regular' && r.status !== 'superseded');
      if (!regular || regular.status !== 'posted') throw new ConflictException(`Payroll period "${period.code}" cannot be closed: its regular run is ${regular ? `"${regular.status}"` : 'missing'}, not "posted".`);
      const openSupp = runs.find((r) => r.kind === 'supplementary' && r.status !== 'posted' && r.status !== 'superseded');
      if (openSupp) throw new ConflictException(`Payroll period "${period.code}" cannot be closed: supplementary run "${openSupp.code}" is still "${openSupp.status}".`);
      period.status = 'closed';
      period.closedAt = new Date();
      period.closedByUserId = actorUserId;
      const saved = await tx.getRepository(PayrollPeriod).save(period);
      await this.sod.record(regular.id, 'close_period', actorUserId, tx);
      await this.audit.record({ actorUserId, organizationId: null, action: 'payroll.period.closed', resource: 'payroll_period', resourceId: periodId, result: 'success', correlationId: null, after: { code: period.code, runId: regular.id } }, tx);
      return saved;
    });
  }

  // ---------------------------------------------------------------------------
  // Compensation — ADR-067 §B. Effective-dated with a reason; a change never rewrites a prior period; the compensation EFFECTIVE for a period is the one used.
  // ---------------------------------------------------------------------------

  async createCompensation(input: CreateCompensationInput, actorUserId: string, manager?: EntityManager): Promise<PayrollCompensation> {
    await this.hr.getEmployee(input.employeeId, manager); // throws NotFoundException if the employee does not exist
    if (!input.reason || input.reason.trim().length < 3) throw new ConflictException('A reason is required for every compensation change.');
    if (!Array.isArray(input.earnings) || input.earnings.length === 0) throw new ConflictException('At least one earning line is required.');
    const seen = new Set<string>();
    for (const line of input.earnings) {
      const code = (line.componentCode ?? '').trim();
      if (code.length === 0 || code.length > 32) throw new ConflictException('Each earning line needs a component code (1-32 characters).');
      if (seen.has(code)) throw new ConflictException(`Earning component "${code}" appears more than once.`);
      seen.add(code);
      if (!isFiniteDecimalString(line.amount) || !dec(line.amount).gt(0)) throw new ConflictException(`Earning line "${code}" must have a positive decimal amount.`);
      if (dec(line.amount).decimalPlaces() > 2) throw new ConflictException(`Earning line "${code}" has more than two decimal places.`);
    }
    const effectiveDate = input.effectiveFrom ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw new ConflictException('effectiveFrom must be a YYYY-MM-DD date.');
    const effectiveFrom = new Date(`${effectiveDate}T00:00:00.000Z`);

    return runInTransaction(this.dataSource, manager, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payroll:compensation:${input.employeeId}`]);
      const repo = tx.getRepository(PayrollCompensation);
      const current = await repo.findOne({ where: { employeeId: input.employeeId, effectiveTo: IsNull() } });
      if (current && effectiveFrom.getTime() <= current.effectiveFrom.getTime()) {
        throw new ConflictException(`The new compensation must take effect after the current one started (${current.effectiveFrom.toISOString().slice(0, 10)}); history is never rewritten.`);
      }
      if (current) {
        current.effectiveTo = effectiveFrom;
        current.status = 'superseded';
        await repo.save(current);
      }
      const saved = await repo.save(repo.create({ employeeId: input.employeeId, effectiveFrom, effectiveTo: null, status: 'active', createdByUserId: actorUserId, reason: input.reason.trim() }));
      for (const line of input.earnings) {
        await tx.getRepository(PayrollEarningLine).save(tx.getRepository(PayrollEarningLine).create({ compensationId: saved.id, componentCode: line.componentCode.trim(), amount: money(line.amount) }));
      }
      // Transparency: does this change reach back into a period that already has a posted run? (No history is touched — the posted lines keep their snapshot; a correction is an adjustment.)
      const [reach]: Array<{ n: number }> = await tx.query(
        `SELECT count(*)::int AS n FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l."payrollRunId" JOIN payroll_periods p ON p.id = r."payrollPeriodId"
          WHERE l."employeeId" = $1 AND r.status = 'posted' AND p."endDate" >= $2::date`,
        [input.employeeId, effectiveDate],
      );
      await this.audit.record(
        {
          actorUserId, organizationId: null, action: 'payroll.compensation.created', resource: 'payroll_compensation', resourceId: saved.id, result: 'success', correlationId: null,
          after: { employeeId: input.employeeId, earnings: input.earnings, effectiveFrom: effectiveDate, reason: input.reason.trim(), supersedes: current?.id ?? null, reachesPostedPeriods: reach?.n ?? 0 },
        },
        tx,
      );
      return saved;
    });
  }

  async listCompensations(employeeId?: string, manager?: EntityManager): Promise<PayrollCompensation[]> {
    return this.repos(manager).compensations.find({ where: employeeId ? { employeeId } : {}, order: { createdAt: 'DESC' } });
  }

  /**
   * The compensation EFFECTIVE at the END of the period (rule: the rate in force on the last day applies in full — no proration rule exists, so a change inside the
   * period is raised as an exception, not guessed). A legacy compensation (no reason) that is an employee's earliest row has no lower bound: it was used for any
   * period before effective dating existed and keeps doing so.
   */
  private async loadEffectiveCompensations(tx: EntityManager, period: PayrollPeriod): Promise<Map<string, EffectiveCompensation>> {
    const endOfDay = new Date(`${period.endDate}T23:59:59.999Z`);
    const startOfPeriod = new Date(`${period.startDate}T00:00:00.000Z`);
    const all = await tx.getRepository(PayrollCompensation).find({ order: { effectiveFrom: 'ASC', createdAt: 'ASC' } });
    const byEmployee = new Map<string, PayrollCompensation[]>();
    for (const c of all) byEmployee.set(c.employeeId, [...(byEmployee.get(c.employeeId) ?? []), c]);
    const chosen = new Map<string, { comp: PayrollCompensation; change: PayrollCompensation | null }>();
    for (const [employeeId, list] of byEmployee) {
      const start = (c: PayrollCompensation, idx: number) => (idx === 0 && c.reason === null ? new Date(0) : c.effectiveFrom);
      let pick: PayrollCompensation | null = null;
      list.forEach((c, idx) => {
        if (start(c, idx) <= endOfDay && (c.effectiveTo === null || c.effectiveTo > endOfDay)) pick = c;
      });
      if (!pick) continue;
      const change = list.find((c, idx) => idx > 0 && c.effectiveFrom > startOfPeriod && c.effectiveFrom <= endOfDay) ?? null;
      chosen.set(employeeId, { comp: pick, change });
    }
    const ids = [...chosen.values()].map((c) => c.comp.id);
    const lines = ids.length > 0 ? await tx.getRepository(PayrollEarningLine).find({ where: { compensationId: In(ids) } }) : [];
    const out = new Map<string, EffectiveCompensation>();
    for (const [employeeId, { comp, change }] of chosen) out.set(employeeId, { compensation: comp, lines: lines.filter((l) => l.compensationId === comp.id), changeInPeriod: change });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Day-type determination — ADR-067 §C. `AttendanceDay.status = 'absent'` never alone implies a deduction; with no calendar source every absent day is
  // `unclassified` / no pay impact (the documented fail-safe), and it is surfaced as an exception that a person must acknowledge.
  // ---------------------------------------------------------------------------

  classifyDay(attendanceStatus: AttendanceStatus): { dayType: PayrollDayType; payImpact: PayrollDayPayImpact } {
    switch (attendanceStatus) {
      case 'on_leave':
        return { dayType: 'approved_leave', payImpact: 'none' };
      case 'present':
        return { dayType: 'working', payImpact: 'none' };
      case 'missing_punch':
        return { dayType: 'working', payImpact: 'none' };
      case 'absent':
        return { dayType: 'unclassified', payImpact: 'none' };
    }
  }

  // ---------------------------------------------------------------------------
  // Input gathering — one function used by the calculation AND by the staleness check at submit / approval.
  // ---------------------------------------------------------------------------

  private async gatherInputs(tx: EntityManager, period: PayrollPeriod, runId: string | null): Promise<GatheredInputs> {
    const employeesAll = await this.hr.listEmployees(tx);
    const employees = employeesAll.map((e) => ({ id: e.id, status: e.status, employmentType: e.employmentType ?? null, hireDate: e.hireDate ?? null, terminationDate: e.terminationDate ?? null }));
    const compensations = await this.loadEffectiveCompensations(tx, period);

    const batches = await this.attendance.listApprovalBatches(tx);
    const relevant = batches.filter((b) => b.status === 'approved' && b.periodStart <= period.endDate && b.periodEnd >= period.startDate);
    const daysByEmployee = new Map<string, Array<{ calendarDate: string; status: AttendanceStatus }>>();
    for (const batch of relevant) {
      const days = await this.attendance.listApprovedDaysByBatch(batch.id, tx);
      for (const day of days) {
        if (day.calendarDate < period.startDate || day.calendarDate > period.endDate) continue;
        const arr = daysByEmployee.get(day.employeeId) ?? [];
        arr.push({ calendarDate: day.calendarDate, status: day.status });
        daysByEmployee.set(day.employeeId, arr);
      }
    }

    // Commission / adjustment sources not held by ANOTHER run's live consumption (this run's own reservations count as available, so the same function can verify a run).
    const consumable = await this.commission.listConsumableForPayroll(period.endDate, tx);
    const payrollAdjRows: Array<{ id: string; employeeId: string; amount: string; originalLineId: string; kind: string }> = await tx.query(
      `SELECT a.id, l."employeeId", a."amountDelta" AS amount, a."originalPayrollRunLineId" AS "originalLineId", a.kind
         FROM payroll_adjustments a JOIN payroll_run_lines l ON l.id = a."originalPayrollRunLineId" JOIN payroll_runs r ON r.id = l."payrollRunId" WHERE r.status = 'posted'`,
    );
    const sourceIds = [...consumable.results.map((r) => r.id), ...consumable.adjustments.map((a) => a.id), ...payrollAdjRows.map((a) => a.id)];
    const taken: Array<{ inputKind: string; sourceId: string }> = sourceIds.length === 0 ? [] : await tx.query(
      `SELECT "inputKind", "sourceId" FROM payroll_input_consumptions WHERE state IN ('reserved','consumed') AND "sourceId" = ANY($1::uuid[]) AND ($2::uuid IS NULL OR "payrollRunId" <> $2::uuid)`,
      [sourceIds, runId],
    );
    const takenKey = new Set(taken.map((t) => `${t.inputKind}:${t.sourceId}`));

    let wagesPayable = false;
    let expense = false;
    try {
      const [wp]: Array<{ n: number }> = await tx.query(`SELECT count(*)::int AS n FROM accounting_gl_accounts WHERE "controlFunction" = 'wages_payable' AND "isActive" = true AND "isPostable" = true`);
      const [ex]: Array<{ n: number }> = await tx.query(`SELECT count(*)::int AS n FROM accounting_gl_accounts WHERE code = $1 AND "isActive" = true AND "isPostable" = true`, [EXPENSE_ACCOUNT_CODE]);
      wagesPayable = (wp?.n ?? 0) > 0;
      expense = (ex?.n ?? 0) > 0;
    } catch {
      // no accounting tables in this Company database — not ready to post
    }

    return {
      employees,
      compensations,
      daysByEmployee,
      batchIds: relevant.map((b) => b.id).sort(),
      commissionResults: consumable.results.filter((r) => !takenKey.has(`commission_result:${r.id}`)),
      commissionAdjustments: consumable.adjustments.filter((a) => !takenKey.has(`commission_adjustment:${a.id}`)),
      payrollAdjustments: payrollAdjRows.filter((a) => !takenKey.has(`payroll_adjustment:${a.id}`)),
      accountingReady: { wagesPayable, expense },
    };
  }

  /** Hash of everything that influences the run's result. Equal hashes at calculation and at approval ⇒ the inputs did not change in between. */
  private fingerprintInputs(period: PayrollPeriod, kind: string, g: GatheredInputs): string {
    const dayHash = (d: Array<{ calendarDate: string; status: string }>) => createHash('sha1').update(d.map((x) => `${x.calendarDate}:${x.status}`).sort().join('|')).digest('hex');
    const payload = {
      period: [period.id, period.startDate, period.endDate, kind],
      employees: g.employees.map((e) => [e.id, e.status, e.employmentType, e.hireDate, e.terminationDate]).sort(),
      compensations: [...g.compensations.entries()].map(([id, c]) => [id, c.compensation.id, c.changeInPeriod?.id ?? null]).sort(),
      batches: g.batchIds,
      attendance: [...g.daysByEmployee.entries()].map(([id, d]) => [id, d.length, dayHash(d)]).sort(),
      results: g.commissionResults.map((r) => r.id).sort(),
      commissionAdjustments: g.commissionAdjustments.map((a) => a.id).sort(),
      payrollAdjustments: g.payrollAdjustments.map((a) => a.id).sort(),
      accounting: [g.accountingReady.wagesPayable, g.accountingReady.expense],
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  // ---------------------------------------------------------------------------
  // PayrollRun — calculation (regular, or supplementary delta for an already-posted period)
  // ---------------------------------------------------------------------------

  async calculate(payrollPeriodId: string, actorUserId: string, manager?: EntityManager): Promise<PayrollRun> {
    return this.calculateInternal(payrollPeriodId, actorUserId, manager, 'regular');
  }

  /** Addendum A-4 R-3 — post-posting recalculation: a NEW run of kind `supplementary` that carries only the deltas against what was already posted for the period. */
  async calculateSupplementary(payrollPeriodId: string, actorUserId: string, manager?: EntityManager): Promise<PayrollRun> {
    return this.calculateInternal(payrollPeriodId, actorUserId, manager, 'supplementary');
  }

  private async releaseReservations(tx: EntityManager, runId: string): Promise<void> {
    await tx.query(`UPDATE payroll_input_consumptions SET state = 'released', "releasedAt" = now() WHERE "payrollRunId" = $1 AND state = 'reserved'`, [runId]);
  }

  private async calculateInternal(payrollPeriodId: string, actorUserId: string, manager: EntityManager | undefined, kind: 'regular' | 'supplementary'): Promise<PayrollRun> {
    await this.ensureNumbering(manager);
    return runInTransaction(this.dataSource, manager, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payroll:period:${payrollPeriodId}`]);
      const period = await tx.getRepository(PayrollPeriod).findOne({ where: { id: payrollPeriodId } });
      if (!period) throw new NotFoundException(`Payroll period "${payrollPeriodId}" not found.`);
      if (kind === 'regular' && period.status === 'closed') throw new ConflictException(`Payroll period "${period.code}" is closed — use a supplementary run for a post-close correction.`);

      const runRepo = tx.getRepository(PayrollRun);
      const runs = await runRepo.find({ where: { payrollPeriodId }, order: { revision: 'DESC' } });
      const nextRevision = (runs[0]?.revision ?? 0) + 1;
      let run!: PayrollRun;
      let isNew = false;

      if (kind === 'regular') {
        const active = runs.find((r) => r.kind === 'regular' && r.status !== 'superseded');
        if (active && active.status === 'posted') throw new ConflictException(`Payroll period "${period.code}" already has a posted run — recalculation requires a supplementary run (POST /payroll/runs/supplementary).`);
        if (active) {
          const state = await this.processEngine.getState(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, active.id, tx);
          if (state === 'draft' || state === 'calculated') run = active;
          else {
            await this.supersede(tx, active, actorUserId);
            run = await this.newRun(tx, period, nextRevision, 'regular', active.id, actorUserId);
            isNew = true;
          }
        } else {
          run = await this.newRun(tx, period, nextRevision, 'regular', null, actorUserId);
          isNew = true;
        }
      } else {
        const posted = runs.filter((r) => r.status === 'posted');
        if (!posted.some((r) => r.kind === 'regular')) throw new ConflictException(`Payroll period "${period.code}" has no posted regular run — a supplementary run corrects a posted period only.`);
        const open = runs.find((r) => r.kind === 'supplementary' && r.status !== 'posted' && r.status !== 'superseded');
        if (open) {
          const state = await this.processEngine.getState(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, open.id, tx);
          if (state === 'draft' || state === 'calculated') run = open;
          else {
            await this.supersede(tx, open, actorUserId);
            run = await this.newRun(tx, period, nextRevision, 'supplementary', open.id, actorUserId);
            isNew = true;
          }
        } else {
          run = await this.newRun(tx, period, nextRevision, 'supplementary', posted[0].id, actorUserId);
          isNew = true;
        }
      }

      // Idempotent recompute of a run that is still only calculated: discard its previous lines and reservations first.
      const existingLines = await tx.getRepository(PayrollRunLine).find({ where: { payrollRunId: run.id } });
      for (const l of existingLines) {
        await tx.getRepository(PayrollAttendanceDayClassification).delete({ payrollRunLineId: l.id });
        await tx.getRepository(PayrollDeductionLine).delete({ payrollRunLineId: l.id });
      }
      if (existingLines.length > 0) await tx.getRepository(PayrollRunLine).delete({ payrollRunId: run.id });
      await this.releaseReservations(tx, run.id);

      const g = await this.gatherInputs(tx, period, run.id);

      // Supplementary baseline: what the posted runs of this period already paid per employee (gross part).
      const baselineGross = new Map<string, string>();
      if (kind === 'supplementary') {
        const rows: Array<{ employeeId: string; gross: string }> = await tx.query(
          `SELECT l."employeeId", COALESCE(SUM(l."grossPay"), 0)::text AS gross FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l."payrollRunId"
            WHERE r."payrollPeriodId" = $1 AND r.status = 'posted' GROUP BY l."employeeId"`,
          [payrollPeriodId],
        );
        for (const r of rows) baselineGross.set(r.employeeId, r.gross);
      }

      const detected: DetectedException[] = [];
      const now = new Date();
      const lineRows: PayrollRunLine[] = [];

      for (const e of g.employees) {
        if (e.employmentType === 'contractor') continue; // ADR-067 §I
        if (e.hireDate && e.hireDate > period.endDate) continue; // not hired yet — not part of this period's population
        if (e.status === 'terminated') {
          if (e.terminationDate && e.terminationDate < period.startDate) continue; // left before the period
          if (kind === 'regular') detected.push({ code: 'TERMINATED_IN_PERIOD', impactClass: 'A_DOC', employeeId: e.id, detail: { terminationDate: e.terminationDate } });
          continue;
        }
        if (e.status === 'on_leave') {
          if (kind === 'regular') detected.push({ code: 'EMPLOYEE_ON_LEAVE_STATUS', impactClass: 'A_DOC', employeeId: e.id, detail: { status: e.status } });
          continue;
        }
        const eff = g.compensations.get(e.id);
        if (!eff) {
          if (kind === 'regular') detected.push({ code: 'NO_COMPENSATION', impactClass: 'A_DOC', employeeId: e.id, detail: { periodEnd: period.endDate } });
          continue;
        }

        const grossFull = sumMoney(eff.lines.map((l) => l.amount));
        const gross = kind === 'supplementary' ? grossFull.minus(dec(baselineGross.get(e.id) ?? 0)) : grossFull;

        // attendance facts (approved only)
        const days = g.daysByEmployee.get(e.id) ?? [];
        const classified = days.map((d) => ({ ...d, ...this.classifyDay(d.status) })).sort((a, b) => a.calendarDate.localeCompare(b.calendarDate));
        if (kind === 'regular') {
          if (days.length === 0) detected.push({ code: 'NO_ATTENDANCE_COVERAGE', impactClass: 'A_DOC', employeeId: e.id, detail: { periodStart: period.startDate, periodEnd: period.endDate } });
          const unclassified = classified.filter((d) => d.dayType === 'unclassified').map((d) => d.calendarDate);
          if (unclassified.length > 0) detected.push({ code: 'UNCLASSIFIED_ABSENCE_DAYS', impactClass: 'A_DOC', employeeId: e.id, detail: { dates: unclassified } });
          if (eff.changeInPeriod) detected.push({ code: 'COMPENSATION_CHANGE_IN_PERIOD', impactClass: 'A_DOC', employeeId: e.id, detail: { appliedCompensationId: eff.compensation.id, changeCompensationId: eff.changeInPeriod.id, effectiveFrom: eff.changeInPeriod.effectiveFrom.toISOString().slice(0, 10) } });
        }

        // commission results (approved, attributed on/before the period end, not held by another run) — reserved exactly once
        const reserved: Array<{ id: string; kind: 'commission_result' | 'commission_adjustment' | 'payroll_adjustment'; amount: string; attributionDate: string | null; carried: boolean; detail: Record<string, unknown> }> = [];
        const tryReserve = async (inputKind: 'commission_result' | 'commission_adjustment' | 'payroll_adjustment', sourceId: string, amount: string, attributionDate: string | null, detail: Record<string, unknown>): Promise<boolean> => {
          const carried = attributionDate !== null && attributionDate < period.startDate;
          const rows: Array<{ id: string }> = await tx.query(
            `INSERT INTO payroll_input_consumptions ("inputKind","sourceId","payrollRunId","employeeId",amount,state,"carriedForward","attributionDate",detail)
             VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7,$8::jsonb)
             ON CONFLICT ("inputKind","sourceId") WHERE state IN ('reserved','consumed') DO NOTHING RETURNING id`,
            [inputKind, sourceId, run.id, e.id, money(amount), carried, attributionDate, JSON.stringify(detail)],
          );
          if (rows.length === 0) {
            detected.push({ code: 'INPUT_TAKEN_BY_ANOTHER_RUN', impactClass: 'INFO', employeeId: e.id, detail: { inputKind, sourceId } });
            return false;
          }
          reserved.push({ id: rows[0].id, kind: inputKind, amount: money(amount), attributionDate, carried, detail });
          return true;
        };
        for (const r of g.commissionResults.filter((x) => x.employeeId === e.id)) await tryReserve('commission_result', r.id, r.amount, r.attributionDate, { policyId: r.policyId });
        for (const a of g.commissionAdjustments.filter((x) => x.employeeId === e.id)) await tryReserve('commission_adjustment', a.id, a.amount, a.attributionDate, { originalResultId: a.originalResultId, kind: a.kind });
        for (const a of g.payrollAdjustments.filter((x) => x.employeeId === e.id)) await tryReserve('payroll_adjustment', a.id, a.amount, null, { originalLineId: a.originalLineId, kind: a.kind });

        const commissionAmount = sumMoney(reserved.filter((r) => r.kind === 'commission_result').map((r) => r.amount));
        const adjustmentsAmount = sumMoney(reserved.filter((r) => r.kind !== 'commission_result').map((r) => r.amount));
        const deductions = dec(0); // no ratified deduction rule exists (ADR-067 §D/§E/§G) — none is computed
        const net = gross.plus(commissionAmount).plus(adjustmentsAmount).minus(deductions);

        if (kind === 'supplementary' && gross.isZero() && reserved.length === 0) continue; // nothing to pay or correct for this employee
        if (reserved.some((r) => r.carried)) detected.push({ code: 'COMMISSION_CARRIED_FORWARD', impactClass: 'INFO', employeeId: e.id, detail: { sourceIds: reserved.filter((r) => r.carried).map((r) => r.id).sort() } });
        if (reserved.some((r) => r.kind !== 'commission_result')) detected.push({ code: 'ADJUSTMENTS_APPLIED', impactClass: 'INFO', employeeId: e.id, detail: { count: reserved.filter((r) => r.kind !== 'commission_result').length } });
        if (net.lt(0)) detected.push({ code: 'NEGATIVE_NET_PAY', impactClass: 'B_APPROVE', employeeId: e.id, detail: { net: money(net) } });

        const line = await tx.getRepository(PayrollRunLine).save(
          tx.getRepository(PayrollRunLine).create({
            payrollRunId: run.id,
            employeeId: e.id,
            compensationSnapshot: { compensationId: eff.compensation.id, effectiveFrom: eff.compensation.effectiveFrom.toISOString(), reason: eff.compensation.reason, earnings: eff.lines.map((l) => ({ componentCode: l.componentCode, amount: l.amount })), ...(kind === 'supplementary' ? { baselineGross: money(baselineGross.get(e.id) ?? 0) } : {}) },
            grossPay: money(gross),
            totalDeductions: money(deductions),
            netPay: money(net),
            commissionAmount: reserved.some((r) => r.kind === 'commission_result') ? money(commissionAmount) : null,
            overtimeAmount: null,
            adjustmentsAmount: money(adjustmentsAmount),
            calculationTimestamp: now,
          }),
        );
        lineRows.push(line);
        if (reserved.length > 0) await tx.query(`UPDATE payroll_input_consumptions SET "payrollRunLineId" = $1 WHERE id = ANY($2::uuid[])`, [line.id, reserved.map((r) => r.id)]);
        if (kind === 'regular') {
          for (const day of classified) {
            await tx.getRepository(PayrollAttendanceDayClassification).save(
              tx.getRepository(PayrollAttendanceDayClassification).create({ payrollRunLineId: line.id, calendarDate: day.calendarDate, attendanceStatus: day.status, dayType: day.dayType, payImpact: day.payImpact }),
            );
          }
        }
      }

      if (!g.accountingReady.wagesPayable) detected.push({ code: 'WAGES_PAYABLE_ACCOUNT_MISSING', impactClass: 'B_APPROVE', employeeId: null, detail: { controlFunction: 'wages_payable' } });
      if (!g.accountingReady.expense) detected.push({ code: 'EXPENSE_ACCOUNT_MISSING', impactClass: 'B_APPROVE', employeeId: null, detail: { code: EXPENSE_ACCOUNT_CODE } });
      if (lineRows.length === 0) detected.push({ code: 'EMPTY_RUN', impactClass: 'B_APPROVE', employeeId: null, detail: { kind } });

      const totalGross = sumMoney(lineRows.map((l) => l.grossPay));
      const totalCommission = sumMoney(lineRows.map((l) => l.commissionAmount));
      const totalAdjustments = sumMoney(lineRows.map((l) => l.adjustmentsAmount));
      const totalDeductions = sumMoney(lineRows.map((l) => l.totalDeductions));
      const totalNet = sumMoney(lineRows.map((l) => l.netPay));

      await this.exceptions.replaceForRun(run.id, detected, tx);

      await this.processEngine.transition(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, run.id, isNew || (await this.processEngine.getState(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, run.id, tx)) === 'draft' ? 'calculate' : 'recalculate', actorUserId, tx);
      run.status = 'calculated';
      run.calculatedAt = now;
      run.totalGross = money(totalGross);
      run.totalCommission = money(totalCommission);
      run.totalAdjustments = money(totalAdjustments);
      run.totalDeductions = money(totalDeductions);
      run.totalNet = money(totalNet);
      run.inputsFingerprint = this.fingerprintInputs(period, kind, g);
      run.rejectedAt = null;
      run.rejectedByUserId = null;
      run.rejectionReason = null;
      await runRepo.save(run);
      await this.sod.record(run.id, 'prepare', actorUserId, tx);

      await this.audit.record({
        actorUserId, organizationId: null, action: 'payroll.run.calculated', resource: 'payroll_run', resourceId: run.id, result: 'success', correlationId: null,
        after: { payrollPeriodId, revision: run.revision, kind, employeeCount: lineRows.length, totalNet: run.totalNet, exceptionCount: detected.length },
      }, tx);
      return run;
    });
  }

  private async newRun(tx: EntityManager, period: PayrollPeriod, revision: number, kind: 'regular' | 'supplementary', supersedesRunId: string | null, actorUserId: string): Promise<PayrollRun> {
    const code = await this.numbering.getNextNumber('payroll_run', tx);
    const run = await tx.getRepository(PayrollRun).save(
      tx.getRepository(PayrollRun).create({ code, payrollPeriodId: period.id, status: 'draft', createdByUserId: actorUserId, revision, kind, supersedesRunId }),
    );
    await this.processEngine.start(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, run.id, tx);
    return run;
  }

  /** Addendum A-4 R-2 — a newer revision replaces a run that never reached `posted`; its reservations are released, its history (lines, exceptions, actors) stays. */
  private async supersede(tx: EntityManager, run: PayrollRun, actorUserId: string): Promise<void> {
    await this.processEngine.transition(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, run.id, 'supersede', actorUserId, tx);
    run.status = 'superseded';
    await tx.getRepository(PayrollRun).save(run);
    await this.releaseReservations(tx, run.id);
    await this.audit.record({ actorUserId, organizationId: null, action: 'payroll.run.superseded', resource: 'payroll_run', resourceId: run.id, result: 'success', correlationId: null, after: { revision: run.revision } }, tx);
  }

  // ---------------------------------------------------------------------------
  // Review / submit / decide
  // ---------------------------------------------------------------------------

  async review(runId: string, actorUserId: string, manager?: EntityManager): Promise<PayrollRun> {
    const run0 = await this.repos(manager).runs.findOne({ where: { id: runId } });
    if (!run0) throw new NotFoundException(`PayrollRun "${runId}" not found.`);
    await this.sod.assert(runId, 'review', actorUserId, manager);
    return runInTransaction(this.dataSource, manager, async (tx) => {
      const run = await tx.getRepository(PayrollRun).findOneOrFail({ where: { id: runId } });
      await this.processEngine.transition(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, runId, 'review', actorUserId, tx);
      run.status = 'reviewed';
      run.reviewedByUserId = actorUserId;
      run.reviewedAt = new Date();
      const saved = await tx.getRepository(PayrollRun).save(run);
      await this.sod.record(runId, 'review', actorUserId, tx);
      await this.audit.record({ actorUserId, organizationId: null, action: 'payroll.run.reviewed', resource: 'payroll_run', resourceId: runId, result: 'success', correlationId: null }, tx);
      return saved;
    });
  }

  /** Verifies, before submission and again before posting, that nothing blocks the run and that the facts it was calculated from have not changed. */
  private async assertRunReady(tx: EntityManager, run: PayrollRun): Promise<void> {
    const blockers = await this.exceptions.blockers(run.id, tx);
    if (blockers.length > 0) {
      const byCode = new Map<string, number>();
      for (const b of blockers) byCode.set(b.code, (byCode.get(b.code) ?? 0) + 1);
      throw new ConflictException({
        statusCode: 409,
        code: 'PAYROLL_EXCEPTIONS_OPEN',
        message: `The run has ${blockers.length} unresolved exception(s) (${[...byCode.entries()].map(([c, n]) => `${c} ×${n}`).join(', ')}). Fix the cause and recalculate, or acknowledge the documented ones.`,
      });
    }
    const [sums]: Array<{ gross: string; commission: string; adjustments: string; deductions: string; net: string }> = await tx.query(
      `SELECT COALESCE(SUM("grossPay"),0)::text AS gross, COALESCE(SUM("commissionAmount"),0)::text AS commission, COALESCE(SUM("adjustmentsAmount"),0)::text AS adjustments, COALESCE(SUM("totalDeductions"),0)::text AS deductions, COALESCE(SUM("netPay"),0)::text AS net FROM payroll_run_lines WHERE "payrollRunId" = $1`,
      [run.id],
    );
    if (!dec(sums.net).eq(dec(run.totalNet)) || !dec(sums.gross).eq(dec(run.totalGross)) || !dec(sums.commission).eq(dec(run.totalCommission)) || !dec(sums.adjustments).eq(dec(run.totalAdjustments))) {
      throw new ConflictException({ statusCode: 409, code: 'PAYROLL_TOTALS_MISMATCH', message: 'The stored run totals no longer equal the sum of its lines — recalculate the run.' });
    }
    const period = await tx.getRepository(PayrollPeriod).findOneOrFail({ where: { id: run.payrollPeriodId } });
    const g = await this.gatherInputs(tx, period, run.id);
    if (this.fingerprintInputs(period, run.kind, g) !== run.inputsFingerprint) {
      throw new ConflictException({ statusCode: 409, code: 'PAYROLL_INPUTS_CHANGED', message: 'The facts this run was calculated from (employees, compensation, approved attendance, approved commission, adjustments, accounting readiness) changed after the calculation — recalculate the run.' });
    }
  }

  /** FA-01 submission — the one human control point (ADR-070 §5/§10). `approved -> posted` is automatic afterward, not a second submission. */
  async submitForApproval(runId: string, actorUserId: string, manager?: EntityManager): Promise<PayrollRun> {
    const run = await this.repos(manager).runs.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException(`PayrollRun "${runId}" not found.`);
    const state = await this.processEngine.getState(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, runId, manager);
    if (state !== 'reviewed') throw new ConflictException(`PayrollRun must be "reviewed" before FA-01 submission (current: "${state}").`);
    await this.sod.assert(runId, 'submit', actorUserId, manager);

    const readyCheck = await runInTransaction(this.dataSource, manager, async (tx) => {
      await this.assertRunReady(tx, run);
      const exceptionRows = await this.exceptions.list(runId, tx);
      const lines = await tx.getRepository(PayrollRunLine).find({ where: { payrollRunId: runId } });
      return {
        employeeCount: lines.length,
        exceptionsHash: createHash('sha256').update(JSON.stringify(exceptionRows.map((e) => [e.fingerprint, e.status, e.decisionRef]).sort())).digest('hex'),
      };
    });

    const approvalRequest = await this.approvals.submit({
      requestTypeCode: APPROVAL_TYPE,
      resourceType: RUN_ENTITY_TYPE,
      resourceId: runId,
      requestedAction: 'approve',
      payload: { payrollRunId: runId, revision: run.revision, kind: run.kind, employeeCount: readyCheck.employeeCount, totalNet: run.totalNet, exceptionsHash: readyCheck.exceptionsHash, inputsFingerprint: run.inputsFingerprint },
      makerUserId: actorUserId,
    }, manager);

    return runInTransaction(this.dataSource, manager, async (tx) => {
      const fresh = await tx.getRepository(PayrollRun).findOneOrFail({ where: { id: runId } });
      fresh.approvalRequestId = approvalRequest.id;
      const saved = await tx.getRepository(PayrollRun).save(fresh);
      await this.sod.record(runId, 'submit', actorUserId, tx);
      await this.audit.record({ actorUserId, organizationId: null, action: 'payroll.run.submitted', resource: 'payroll_run', resourceId: runId, result: 'success', correlationId: approvalRequest.id }, tx);
      return saved;
    });
  }

  /**
   * The Payroll route's decision wrapper. The separation-of-duties check runs here (clear 403 for the common path) AND again inside `onApprovalApproved` (the
   * generic approvals route and any direct engine call reach that handler too) — the server never relies on the caller going through this method.
   */
  async decide(requestId: string, approverUserId: string, decision: 'approved' | 'rejected', note?: string | null, manager?: EntityManager): Promise<unknown> {
    if (decision === 'approved') {
      const run = await this.repos(manager).runs.findOne({ where: { approvalRequestId: requestId } });
      if (run) await this.sod.assert(run.id, 'approve', approverUserId, manager);
    }
    return this.approvals.decide(requestId, approverUserId, decision, note ?? null, manager);
  }

  async acknowledgeExceptions(runId: string, selector: { exceptionIds?: string[]; code?: string }, decisionRef: string, actorUserId: string, manager?: EntityManager) {
    return this.exceptions.acknowledge(runId, selector, decisionRef, actorUserId, manager);
  }

  async listExceptions(runId: string, manager?: EntityManager) {
    await this.getRun(runId, manager);
    return this.exceptions.list(runId, manager);
  }

  async listStageActors(runId: string, manager?: EntityManager): Promise<PayrollRunStageActor[]> {
    return this.em(manager).getRepository(PayrollRunStageActor).find({ where: { payrollRunId: runId }, order: { at: 'ASC' } });
  }

  async listInputConsumptions(runId: string, manager?: EntityManager): Promise<PayrollInputConsumption[]> {
    return this.em(manager).getRepository(PayrollInputConsumption).find({ where: { payrollRunId: runId }, order: { createdAt: 'ASC' } });
  }

  async listRuns(manager?: EntityManager): Promise<PayrollRun[]> {
    return this.repos(manager).runs.find({ order: { createdAt: 'DESC' } });
  }

  async getRun(id: string, manager?: EntityManager): Promise<{ run: PayrollRun; lines: PayrollRunLine[] }> {
    const run = await this.repos(manager).runs.findOne({ where: { id } });
    if (!run) throw new NotFoundException(`PayrollRun "${id}" not found.`);
    const lines = await this.repos(manager).runLines.find({ where: { payrollRunId: id } });
    return { run, lines };
  }

  /**
   * The Frontend's own explicit three-state distinction requirement:
   * `PayrollRun.status`, `FinancialEvent.status`, and Treasury
   * disbursement are never the same state (`ADR-070 §6`). Returns `null`
   * when no `FinancialEvent` has landed yet.
   */
  async getFinancialEventStatus(runId: string, manager?: EntityManager): Promise<{ status: string; rejectionReason: string | null; journalEntryId: string | null } | null> {
    const [event]: Array<{ status: string; rejectionReason: string | null; journalEntryId: string | null }> = await this.em(manager).query(
      `SELECT status, "rejectionReason", "journalEntryId" FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
      [runId],
    );
    return event ?? null;
  }

  async listDayClassifications(payrollRunLineId: string, manager?: EntityManager): Promise<PayrollAttendanceDayClassification[]> {
    return this.repos(manager).dayClassifications.find({ where: { payrollRunLineId }, order: { calendarDate: 'ASC' } });
  }

  // ---------------------------------------------------------------------------
  // FA-01 subscribers
  // ---------------------------------------------------------------------------

  /** Reads who approved a request (the event payload carries no approver). */
  private async approversOf(tx: EntityManager, approvalRequestId: string): Promise<string[]> {
    const rows: Array<{ approverUserId: string }> = await tx.query(`SELECT "approverUserId" FROM approval_decisions WHERE "approvalRequestId" = $1 AND decision = 'approved'`, [approvalRequestId]);
    return rows.map((r) => r.approverUserId);
  }

  private async onApprovalApproved(payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (requestTypeCode !== APPROVAL_TYPE) return;
    const resourceId = String(payload.resourceId ?? '');
    const approvalRequestId = String(payload.approvalRequestId ?? '');
    const run = await this.repos(manager).runs.findOne({ where: { id: resourceId } });
    if (!run || run.status === 'posted') return; // not found, or already applied — benign no-op
    if (run.status === 'superseded' || run.approvalRequestId !== approvalRequestId) {
      await this.audit.record({ actorUserId: SYSTEM_ACTOR_ID, organizationId: null, action: 'payroll.run.stale_approval_ignored', resource: 'payroll_run', resourceId: run.id, result: 'denied', correlationId: approvalRequestId, after: { status: run.status } }, manager);
      return;
    }

    // Policy gate (server-side, whichever route reached the engine): separation of duties of every approver, no open exception, inputs unchanged.
    let refusal: string | null = null;
    try {
      const approvers = await this.approversOf(this.em(manager), approvalRequestId);
      for (const approver of approvers) await this.sod.assert(run.id, 'approve', approver, manager);
      await runInTransaction(this.dataSource, manager, async (tx) => this.assertRunReady(tx, run));
    } catch (err) {
      refusal = err instanceof ForbiddenException || err instanceof ConflictException ? (err.getResponse() as { message?: string }).message ?? err.message : err instanceof Error ? err.message : String(err);
      if (!(err instanceof ForbiddenException || err instanceof ConflictException)) throw err;
    }
    if (refusal) {
      await runInTransaction(this.dataSource, manager, async (tx) => {
        const fresh = await tx.getRepository(PayrollRun).findOneOrFail({ where: { id: run.id } });
        await this.processEngine.transition(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, run.id, 'reject', SYSTEM_ACTOR_ID, tx);
        fresh.status = 'calculated';
        fresh.approvalRequestId = null;
        fresh.rejectedAt = new Date();
        fresh.rejectedByUserId = SYSTEM_ACTOR_ID;
        fresh.rejectionReason = `Approval refused by policy: ${refusal}`;
        await tx.getRepository(PayrollRun).save(fresh);
        await this.audit.record({ actorUserId: SYSTEM_ACTOR_ID, organizationId: null, action: 'payroll.run.approval_refused_by_policy', resource: 'payroll_run', resourceId: run.id, result: 'denied', correlationId: approvalRequestId, after: { reason: refusal } }, tx);
      });
      return;
    }

    await runInTransaction(this.dataSource, manager, async (tx) => {
      const fresh = await tx.getRepository(PayrollRun).findOneOrFail({ where: { id: run.id } });
      if (fresh.status === 'posted') return;
      const approvers = await this.approversOf(tx, approvalRequestId);
      for (const approver of approvers) await this.sod.record(run.id, 'approve', approver, tx);

      await this.processEngine.transition(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, run.id, 'approve', SYSTEM_ACTOR_ID, tx);
      await this.processEngine.transition(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, run.id, 'post', SYSTEM_ACTOR_ID, tx);
      fresh.status = 'posted';
      fresh.approvedAt = new Date();
      fresh.postedAt = new Date();
      await tx.getRepository(PayrollRun).save(fresh);

      // Exactly-once consumption: every reservation of this run becomes consumed in this same transaction.
      const [{ n: reservedCount }]: Array<{ n: number }> = await tx.query(`SELECT count(*)::int AS n FROM payroll_input_consumptions WHERE "payrollRunId" = $1 AND state = 'reserved'`, [run.id]);
      // TypeORM's postgres driver returns [rows, affectedCount] for UPDATE ... RETURNING
      const updated = await tx.query(`UPDATE payroll_input_consumptions SET state = 'consumed', "consumedAt" = now() WHERE "payrollRunId" = $1 AND state = 'reserved' RETURNING id`, [run.id]);
      const consumed: Array<{ id: string }> = Array.isArray(updated[0]) ? updated[0] : updated;
      if (consumed.length !== reservedCount) throw new Error(`Payroll run ${run.id}: consumption mismatch (${consumed.length} of ${reservedCount}) — posting rolled back.`);

      const lines = await tx.getRepository(PayrollRunLine).find({ where: { payrollRunId: run.id } });
      const totalExpense = sumMoney(lines.map((l) => dec(l.grossPay).plus(dec(l.commissionAmount)).plus(dec(l.adjustmentsAmount))));
      // ADR-070 §13 — the ONE Payroll transaction: process transitions + consumption + the outbox row, then COMMIT. GL posting happens later in the handler's own transaction.
      await this.events.publish(tx, 'payroll.run.posted', {
        sourceEntityType: RUN_ENTITY_TYPE,
        sourceEntityId: run.id,
        payrollRunId: run.id,
        payrollPeriodId: run.payrollPeriodId,
        revision: run.revision,
        kind: run.kind,
        totalGross: money(sumMoney(lines.map((l) => l.grossPay))),
        totalCommission: money(sumMoney(lines.map((l) => l.commissionAmount))),
        totalAdjustments: money(sumMoney(lines.map((l) => l.adjustmentsAmount))),
        totalDeductions: money(sumMoney(lines.map((l) => l.totalDeductions))),
        totalExpense: money(totalExpense),
        totalNet: money(sumMoney(lines.map((l) => l.netPay))),
        employeeCount: lines.length,
      });
      await this.audit.record({ actorUserId: SYSTEM_ACTOR_ID, organizationId: null, action: 'payroll.run.posted', resource: 'payroll_run', resourceId: run.id, result: 'success', correlationId: approvalRequestId, after: { totalNet: fresh.totalNet, revision: run.revision, consumed: consumed.length } }, tx);
    });
    // The handler runs inside the approval engine's own dispatch pass; the row published above did not exist when that pass started, so the publisher dispatches.
    await this.events.dispatchAfterCommit(manager);
  }

  /** Addendum A-9 — the explicit rejection path: `reviewed -> calculated`, request history kept, reason recorded, resubmission = a new request. */
  private async onApprovalRejected(payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (requestTypeCode !== APPROVAL_TYPE) return;
    const resourceId = String(payload.resourceId ?? '');
    const approvalRequestId = String(payload.approvalRequestId ?? '');
    const run = await this.repos(manager).runs.findOne({ where: { id: resourceId } });
    if (!run || run.approvalRequestId !== approvalRequestId || run.status !== 'reviewed') return; // stale, superseded or already handled — benign no-op
    await runInTransaction(this.dataSource, manager, async (tx) => {
      const fresh = await tx.getRepository(PayrollRun).findOneOrFail({ where: { id: run.id } });
      if (fresh.status !== 'reviewed' || fresh.approvalRequestId !== approvalRequestId) return;
      const [decision]: Array<{ approverUserId: string; note: string | null }> = await tx.query(
        `SELECT "approverUserId", note FROM approval_decisions WHERE "approvalRequestId" = $1 AND decision = 'rejected' ORDER BY "decidedAt" DESC LIMIT 1`,
        [approvalRequestId],
      );
      await this.processEngine.transition(PAYROLL_RUN_PROCESS, RUN_ENTITY_TYPE, run.id, 'reject', SYSTEM_ACTOR_ID, tx);
      fresh.status = 'calculated';
      fresh.approvalRequestId = null;
      fresh.rejectedAt = new Date();
      fresh.rejectedByUserId = decision?.approverUserId ?? SYSTEM_ACTOR_ID;
      fresh.rejectionReason = decision?.note ?? 'Rejected by the approver.';
      await tx.getRepository(PayrollRun).save(fresh);
      await this.audit.record({ actorUserId: decision?.approverUserId ?? SYSTEM_ACTOR_ID, organizationId: null, action: 'payroll.run.rejected', resource: 'payroll_run', resourceId: run.id, result: 'success', correlationId: approvalRequestId, after: { reason: fresh.rejectionReason } }, tx);
    });
  }

  // ---------------------------------------------------------------------------
  // Reconciliation / disbursement / settings (delegates)
  // ---------------------------------------------------------------------------

  async listReconciliationGaps(manager?: EntityManager): Promise<Array<{ payrollRunId: string; code: string }>> {
    const rows: Array<{ id: string; code: string }> = await this.em(manager).query(`
      SELECT pr.id, pr.code FROM payroll_runs pr
      LEFT JOIN accounting_financial_events fe
        ON fe."sourceEntityType" = 'PayrollRun' AND fe."sourceEntityId"::text = pr.id::text
      WHERE pr.status = 'posted'
        AND (fe.id IS NULL OR fe.status NOT IN ('POSTED'))
    `);
    return rows.map((r) => ({ payrollRunId: r.id, code: r.code }));
  }

  async reconcile(runId: string, manager?: EntityManager): Promise<PayrollReconciliation> {
    return this.payouts.reconcile(runId, manager);
  }

  /** Legacy single action: pay everything outstanding through a payout batch. */
  async disburse(runId: string, treasuryAccountId: string, actorUserId: string, manager?: EntityManager): Promise<PayrollRun> {
    return this.payouts.disburseAll(runId, treasuryAccountId, actorUserId, manager);
  }

  async getSodProfile(manager?: EntityManager) {
    return this.sod.getProfile(manager);
  }

  async setSodProfile(profile: 'standard' | 'strict', actorUserId: string, manager?: EntityManager) {
    if (profile !== 'standard' && profile !== 'strict') throw new ConflictException('Profile must be "standard" or "strict".');
    return this.sod.setProfile(profile, actorUserId, manager);
  }

  // ---------------------------------------------------------------------------
  // Adjustments — ADR-067 §M. A record linked to the original line of a POSTED run; it changes nothing by itself and is consumed once by the next open run.
  // ---------------------------------------------------------------------------

  async createAdjustment(input: CreateAdjustmentInput, actorUserId: string, manager?: EntityManager): Promise<PayrollAdjustment> {
    const line = await this.repos(manager).runLines.findOne({ where: { id: input.originalPayrollRunLineId } });
    if (!line) throw new NotFoundException(`PayrollRunLine "${input.originalPayrollRunLineId}" not found.`);
    const run = await this.repos(manager).runs.findOneOrFail({ where: { id: line.payrollRunId } });
    if (run.status !== 'posted') throw new ConflictException(`An adjustment corrects a POSTED run; run "${run.code}" is "${run.status}" — recalculate it instead.`);
    if (!isFiniteDecimalString(input.amountDelta) || dec(input.amountDelta).isZero()) throw new ConflictException('amountDelta must be a non-zero decimal number.');
    if (dec(input.amountDelta).decimalPlaces() > 2) throw new ConflictException('amountDelta has more than two decimal places.');
    if (!input.reason || input.reason.trim().length === 0) throw new ConflictException('An adjustment needs a reason.');

    const saved = await this.repos(manager).adjustments.save(
      this.repos(manager).adjustments.create({
        originalPayrollRunLineId: input.originalPayrollRunLineId,
        kind: input.kind,
        reason: input.reason.trim(),
        amountDelta: money(input.amountDelta),
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
      after: { originalPayrollRunLineId: input.originalPayrollRunLineId, kind: input.kind, amountDelta: saved.amountDelta, reason: saved.reason },
    }, manager);
    return saved;
  }

  async listAdjustments(originalPayrollRunLineId?: string, manager?: EntityManager): Promise<PayrollAdjustment[]> {
    return this.repos(manager).adjustments.find({ where: originalPayrollRunLineId ? { originalPayrollRunLineId } : {}, order: { createdAt: 'DESC' } });
  }
}
