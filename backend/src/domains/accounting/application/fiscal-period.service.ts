import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { FiscalYear } from '../infrastructure/fiscal-year.entity';
import { FiscalPeriod } from '../infrastructure/fiscal-period.entity';
import {
  FISCAL_PERIOD_ENTITY_TYPE,
  FISCAL_PERIOD_PROCESS,
  FISCAL_YEAR_ENTITY_TYPE,
  FISCAL_YEAR_PROCESS,
} from '../domain/process-definitions';
import {
  FISCAL_CLOSING_META,
  FISCAL_CLOSING_REQUEST_TYPES,
  FISCAL_PERIOD_APPROVER_PERMISSION_NODE,
  FISCAL_PERIOD_STATUS_CHANGED_EVENT,
  FISCAL_YEAR_APPROVER_PERMISSION_NODE,
  FISCAL_YEAR_STATUS_CHANGED_EVENT,
} from '../domain/fiscal-closing';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { ApprovalEngineService, ApprovalRequestView } from '../../../foundation/approval-engine/approval-engine.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ClosingAuditService } from './closing-audit.service';
import { ClosingWorkflowRun } from '../infrastructure/closing-workflow-run.entity';
import { ClosingSnapshotService } from './closing-snapshot.service';

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000'; // ADR-046 D7 — matches this codebase's existing convention (F04-F12) for actions triggered by an internal subscriber, not a live user.
const THRESHOLD_ALWAYS_GATED: string | null = null; // ADR-046 D4/D13-style — always requires approval, no value-based bypass.

export interface CreateFiscalYearInput {
  code: string;
  startDate: string;
  endDate: string;
  orgUnitId?: string | null;
}

export interface FiscalYearView extends FiscalYear {
  status: string;
}
export interface FiscalPeriodView extends FiscalPeriod {
  status: string;
}

/**
 * F01 — Financial Foundation (Blueprint §3.3/§3.4/§5). Neither `FiscalYear`
 * nor `FiscalPeriod` stores its own status column — every read resolves
 * the live state via `ProcessEngineService`, matching `SalesOrder`'s
 * established convention.
 *
 * F13 — Financial Closing (ADR-046). Adds the approval *policy* F01
 * explicitly deferred: FA-01-gates the `close`/`reopen` transitions (D4),
 * publishes the previously-declared-but-dormant `*.status_changed` events
 * (D6), fixes the reopened-period-cannot-post defect (D2) and the
 * `FiscalYear.status` posting-gate gap (D3), and enforces the
 * Fiscal-Year-close integrity invariant — every child period must already
 * be `closed` — at both submission and decision time (D10).
 *
 * `accounting.default_fiscal_year_period_length` (config key, default
 * `'monthly'`) — period generation uses the config's own stated default
 * directly (monthly) rather than a live `ConfigurationEngineService`
 * read, for the same disclosed reason as `CurrencyService.setBaseCurrency`
 * — no domain in this codebase consumes that engine's values yet.
 */
@Injectable()
export class FiscalPeriodService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalEngineService,
    private readonly events: EventBusService,
    private readonly closingAudit: ClosingAuditService,
    private readonly closingSnapshot: ClosingSnapshotService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.approvals.registerRequestType(FISCAL_CLOSING_REQUEST_TYPES.periodClose, 'action.fiscal_period_close');
    await this.approvals.registerRequestType(FISCAL_CLOSING_REQUEST_TYPES.periodReopen, 'action.fiscal_period_reopen');
    await this.approvals.registerRequestType(FISCAL_CLOSING_REQUEST_TYPES.yearClose, 'action.fiscal_year_close');

    await this.approvals
      .upsertMatrixRule(
        {
          requestTypeCode: FISCAL_CLOSING_REQUEST_TYPES.periodClose,
          minApprovers: FISCAL_CLOSING_META.minApprovers,
          requiredPermissionNode: FISCAL_PERIOD_APPROVER_PERMISSION_NODE,
          valueThreshold: THRESHOLD_ALWAYS_GATED,
          orgUnitId: null,
        },
        SYSTEM_ACTOR_ID,
      )
      .catch(() => undefined);
    await this.approvals
      .upsertMatrixRule(
        {
          requestTypeCode: FISCAL_CLOSING_REQUEST_TYPES.periodReopen,
          minApprovers: FISCAL_CLOSING_META.minApprovers,
          requiredPermissionNode: FISCAL_PERIOD_APPROVER_PERMISSION_NODE,
          valueThreshold: THRESHOLD_ALWAYS_GATED,
          orgUnitId: null,
        },
        SYSTEM_ACTOR_ID,
      )
      .catch(() => undefined);
    // ADR-051 §1.3/§5 — reclose (`reopened -> closed`), same matrix shape as periodClose for V1.
    await this.approvals.registerRequestType(FISCAL_CLOSING_REQUEST_TYPES.periodReclose, 'action.fiscal_period_reclose');
    await this.approvals
      .upsertMatrixRule(
        {
          requestTypeCode: FISCAL_CLOSING_REQUEST_TYPES.periodReclose,
          minApprovers: FISCAL_CLOSING_META.minApprovers,
          requiredPermissionNode: FISCAL_PERIOD_APPROVER_PERMISSION_NODE,
          valueThreshold: THRESHOLD_ALWAYS_GATED,
          orgUnitId: null,
        },
        SYSTEM_ACTOR_ID,
      )
      .catch(() => undefined);
    await this.approvals
      .upsertMatrixRule(
        {
          requestTypeCode: FISCAL_CLOSING_REQUEST_TYPES.yearClose,
          minApprovers: FISCAL_CLOSING_META.minApprovers,
          requiredPermissionNode: FISCAL_YEAR_APPROVER_PERMISSION_NODE,
          valueThreshold: THRESHOLD_ALWAYS_GATED,
          orgUnitId: null,
        },
        SYSTEM_ACTOR_ID,
      )
      .catch(() => undefined);

    this.events.subscribe('approval.request.approved', async (payload) => {
      await this.onApprovalApproved(payload as Record<string, unknown>);
    });
  }

  async createFiscalYear(input: CreateFiscalYearInput, actorUserId: string): Promise<FiscalYearView> {
    const fiscalYear = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FiscalYear);
      const saved = await repo.save(
        repo.create({ code: input.code, startDate: input.startDate, endDate: input.endDate, orgUnitId: input.orgUnitId ?? null }),
      );

      await this.processEngine.start(FISCAL_YEAR_PROCESS, FISCAL_YEAR_ENTITY_TYPE, saved.id);

      const periodRepo = manager.getRepository(FiscalPeriod);
      for (const [start, end, code] of this.monthlyPeriods(input.startDate, input.endDate)) {
        const period = await periodRepo.save(periodRepo.create({ fiscalYearId: saved.id, code, startDate: start, endDate: end }));
        await this.processEngine.start(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, period.id);
      }

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.fiscal_year.created',
          resource: 'fiscal_year',
          resourceId: saved.id,
          result: 'success',
          correlationId: null,
          after: { code: saved.code, startDate: saved.startDate, endDate: saved.endDate },
        },
        manager,
      );

      return saved;
    });

    return this.toFiscalYearView(fiscalYear);
  }

  /** Splits [startDate, endDate] into calendar-month periods, code `YYYY-MM`. Last period is truncated to `endDate`, never overruns it. */
  private monthlyPeriods(startDate: string, endDate: string): Array<[string, string, string]> {
    const periods: Array<[string, string, string]> = [];
    const end = new Date(endDate + 'T00:00:00Z');
    let cursor = new Date(startDate + 'T00:00:00Z');
    while (cursor <= end) {
      const year = cursor.getUTCFullYear();
      const month = cursor.getUTCMonth();
      const periodStart = new Date(Date.UTC(year, month, cursor.getUTCDate() === 1 ? 1 : cursor.getUTCDate()));
      const monthEnd = new Date(Date.UTC(year, month + 1, 0));
      const periodEnd = monthEnd < end ? monthEnd : end;
      const code = `${year}-${String(month + 1).padStart(2, '0')}`;
      periods.push([this.toDateString(periodStart), this.toDateString(periodEnd), code]);
      cursor = new Date(Date.UTC(year, month + 1, 1));
    }
    return periods;
  }

  private toDateString(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  async listFiscalYears(): Promise<FiscalYearView[]> {
    const years = await this.dataSource.getRepository(FiscalYear).find({ order: { startDate: 'DESC' } });
    return Promise.all(years.map((y) => this.toFiscalYearView(y)));
  }

  async getFiscalYear(id: string): Promise<FiscalYearView> {
    const year = await this.dataSource.getRepository(FiscalYear).findOne({ where: { id } });
    if (!year) throw new NotFoundException(`Fiscal year "${id}" not found.`);
    return this.toFiscalYearView(year);
  }

  private async toFiscalYearView(year: FiscalYear): Promise<FiscalYearView> {
    const status = await this.processEngine.getState(FISCAL_YEAR_PROCESS, FISCAL_YEAR_ENTITY_TYPE, year.id);
    return { ...year, status };
  }

  /**
   * "Exactly one active FiscalYear per orgUnitId scope" — checked
   * immediately before firing the transition. Disclosed, not hidden: this
   * is a check-then-act pair, not a single atomic operation (Process
   * Engine's own `transition()` always opens its own fresh transaction and
   * does not accept an external manager — extending it to do so is
   * explicitly out of this Blueprint's scope, "no scope creep"). A real
   * race requires two concurrent activation attempts for the SAME scope
   * within the same instant — fiscal-year activation is a rare, deliberate,
   * low-frequency admin action, so this is an accepted, documented
   * limitation for V1, not an oversight (Governance Rule 12).
   *
   * ADR-046 D4 — `activate` stays plain-permission, not FA-01-gated
   * (low-risk: activating a fresh, never-posted-into year).
   */
  async activateFiscalYear(id: string, actorUserId: string): Promise<FiscalYearView> {
    const year = await this.dataSource.getRepository(FiscalYear).findOne({ where: { id } });
    if (!year) throw new NotFoundException(`Fiscal year "${id}" not found.`);

    const others = await this.dataSource
      .getRepository(FiscalYear)
      .find({ where: { orgUnitId: year.orgUnitId === null ? IsNull() : year.orgUnitId } });
    for (const other of others) {
      if (other.id === id) continue;
      const otherStatus = await this.processEngine.getState(FISCAL_YEAR_PROCESS, FISCAL_YEAR_ENTITY_TYPE, other.id);
      if (otherStatus === 'active') {
        throw new ConflictException(
          `Fiscal year "${other.code}" is already active in this scope — only one fiscal year may be active at a time.`,
        );
      }
    }

    await this.processEngine.transition(FISCAL_YEAR_PROCESS, FISCAL_YEAR_ENTITY_TYPE, id, 'activate', actorUserId);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.fiscal_year.activated',
      resource: 'fiscal_year',
      resourceId: id,
      result: 'success',
      correlationId: null,
    });
    return this.toFiscalYearView(year);
  }

  async listPeriods(fiscalYearId: string): Promise<FiscalPeriodView[]> {
    const periods = await this.dataSource.getRepository(FiscalPeriod).find({ where: { fiscalYearId }, order: { startDate: 'ASC' } });
    return Promise.all(
      periods.map(async (p) => ({ ...p, status: await this.processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, p.id) })),
    );
  }

  /**
   * Generic transition entry point for a `FiscalPeriod` — covers ONLY
   * `soft_close`/`reopen_from_soft_close` (ADR-046 D4 — `close`/`reopen`
   * are FA-01-gated; ADR-051 §1.2 additionally removes `close_after_reopen`
   * from this routine, ungated path — it was reachable here before this
   * revision, bypassing both FA-01 and the Closing Audit, exactly the
   * "silent shortcut" the reclose review flagged. All three gated actions
   * are submitted via `submitPeriodClose`/`submitPeriodReopen` below, never
   * fired directly here; the controller's own DTO enforces this at the
   * HTTP boundary too).
   */
  async transitionPeriod(id: string, action: string, actorUserId: string): Promise<FiscalPeriodView> {
    if (action === 'close' || action === 'reopen' || action === 'close_after_reopen') {
      throw new ConflictException(
        `Action "${action}" must go through the FA-01 approval flow (submitPeriodClose/submitPeriodReopen) — it cannot be fired directly.`,
      );
    }
    const period = await this.dataSource.getRepository(FiscalPeriod).findOne({ where: { id } });
    if (!period) throw new NotFoundException(`Fiscal period "${id}" not found.`);
    await this.dataSource.transaction(async (manager) => {
      await this.applyPeriodTransition(manager, id, action, actorUserId, null);
    });
    const status = await this.processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, id);
    return { ...period, status };
  }

  /**
   * ADR-046 D6 — the one place every `FiscalPeriod` transition (routine or
   * FA-01-approved) actually applies: the Process Engine transition, the
   * audit record, and the `status_changed` publish all share the SAME
   * transaction via the caller-supplied `manager` — no partial-effect state
   * is possible.
   */
  private async applyPeriodTransition(
    manager: EntityManager,
    periodId: string,
    action: string,
    actorUserId: string,
    correlationId: string | null,
  ): Promise<{ fromStatus: string; toStatus: string }> {
    const fromStatus = await this.processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, periodId, manager);
    const instance = await this.processEngine.transition(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, periodId, action, actorUserId, manager);
    const toStatus = instance.currentState;
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: `accounting.fiscal_period.${action}`,
        resource: 'fiscal_period',
        resourceId: periodId,
        result: 'success',
        correlationId,
        after: { fromStatus, toStatus },
      },
      manager,
    );
    await this.events.publish(manager, FISCAL_PERIOD_STATUS_CHANGED_EVENT, {
      fiscalPeriodId: periodId,
      fromStatus,
      toStatus,
      actorUserId,
      businessDate: this.toDateString(new Date()),
    });
    return { fromStatus, toStatus };
  }

  /** ADR-050 — lets a maker preview Closing Audit exceptions before submitting (`accounting.fiscal_period.view`, controller-enforced). Runs a fresh audit each call — read-only, same cost as any other reconciliation preview. */
  async previewClosingAudit(periodId: string, actorUserId: string) {
    return this.closingAudit.run(periodId, actorUserId);
  }

  /** ADR-050 — prior Closing Audit runs for this period, newest first. */
  async listClosingAuditRuns(periodId: string) {
    return this.closingAudit.listRuns(periodId);
  }

  // ---------------------------------------------------------------------------
  // ADR-046 D4 — FA-01 submission (maker side) for the gated transitions
  // ---------------------------------------------------------------------------

  /**
   * ADR-051 §1.3 — ONE entry point for both the first close (`soft_close`)
   * and a reclose after reopening (`reopened`), replacing the two-path
   * design the review flagged. Submit-side permission:
   * `accounting.fiscal_period.edit` (controller-enforced), unchanged.
   * Before an FA-01 request is even created, runs the Closing Audit and
   * hard-blocks on any `blocking` exception (a live AP/AR/Cash-Bank/
   * Inventory/Fixed-Asset drift, or an unresolved CONFIGURATION_EXCEPTION/
   * UNCLASSIFIED_REJECTION financial event — ADR-051 §2/§7's ALWAYS-fresh
   * Final Reconciliation). This never touches the approval flow itself; it
   * only refuses to create the request in the first place. Which of the
   * two FA-01 request types (and, later, which `FISCAL_PERIOD_PROCESS`
   * action) applies is determined by the period's OWN current state —
   * never by which method the caller happened to call.
   */
  async submitPeriodClose(periodId: string, actorUserId: string): Promise<ApprovalRequestView> {
    const period = await this.dataSource.getRepository(FiscalPeriod).findOne({ where: { id: periodId } });
    if (!period) throw new NotFoundException(`Fiscal period "${periodId}" not found.`);
    const status = await this.processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, periodId);
    if (status !== 'soft_close' && status !== 'reopened') {
      throw new ConflictException(`Fiscal period "${period.code}" is "${status}" — must be "soft_close" or "reopened" before it can be (re)closed.`);
    }
    const entryState: 'soft_close' | 'reopened' = status;
    const requestTypeCode = entryState === 'soft_close' ? FISCAL_CLOSING_REQUEST_TYPES.periodClose : FISCAL_CLOSING_REQUEST_TYPES.periodReclose;
    const requestedAction = entryState === 'soft_close' ? 'close' : 'close_after_reopen';

    const workflowRepo = this.dataSource.getRepository(ClosingWorkflowRun);
    const workflowRun = await workflowRepo.save(workflowRepo.create({ fiscalPeriodId: periodId, entryState, status: 'audit_run' }));

    let finalReconciliationRun;
    try {
      finalReconciliationRun = await this.closingAudit.assertCleanForClose(periodId, actorUserId);
    } catch (err) {
      workflowRun.status = 'exceptions_open';
      workflowRun.completedAt = new Date();
      await workflowRepo.save(workflowRun);
      throw err;
    }

    workflowRun.finalReconciliationRunId = finalReconciliationRun.id;
    workflowRun.status = 'final_reconciliation_passed';
    await workflowRepo.save(workflowRun);

    const approvalRequest = await this.approvals.submit({
      requestTypeCode,
      resourceType: 'fiscal_period',
      resourceId: periodId,
      requestedAction,
      payload: { fiscalPeriodId: periodId },
      makerUserId: actorUserId,
    });

    workflowRun.approvalRequestId = approvalRequest.id;
    workflowRun.status = 'approval_submitted';
    await workflowRepo.save(workflowRun);

    return approvalRequest;
  }

  /** ADR-051 §1/§6 — evidence trail for a period's closing attempts, newest first. */
  async listClosingWorkflowRuns(periodId: string): Promise<ClosingWorkflowRun[]> {
    return this.dataSource.getRepository(ClosingWorkflowRun).find({ where: { fiscalPeriodId: periodId }, order: { createdAt: 'DESC' } });
  }

  /** Submit-side permission: the already-existing `accounting.fiscal_period.reopen` node (controller-enforced), unchanged. */
  async submitPeriodReopen(periodId: string, actorUserId: string): Promise<ApprovalRequestView> {
    const period = await this.dataSource.getRepository(FiscalPeriod).findOne({ where: { id: periodId } });
    if (!period) throw new NotFoundException(`Fiscal period "${periodId}" not found.`);
    const status = await this.processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, periodId);
    if (status !== 'closed') {
      throw new ConflictException(`Fiscal period "${period.code}" is "${status}" — must be "closed" before it can be reopened.`);
    }
    return this.approvals.submit({
      requestTypeCode: FISCAL_CLOSING_REQUEST_TYPES.periodReopen,
      resourceType: 'fiscal_period',
      resourceId: periodId,
      requestedAction: 'reopen',
      payload: { fiscalPeriodId: periodId },
      makerUserId: actorUserId,
    });
  }

  /**
   * ADR-046 D10 — submission-time precondition: every child period must
   * already be `closed`. Revalidated (not merely trusted) at decision time
   * in `applyApprovedYearClose` below, since a period can be `reopen`ed
   * during the unbounded FA-01 approval window.
   */
  async submitYearClose(yearId: string, actorUserId: string): Promise<ApprovalRequestView> {
    const year = await this.dataSource.getRepository(FiscalYear).findOne({ where: { id: yearId } });
    if (!year) throw new NotFoundException(`Fiscal year "${yearId}" not found.`);
    const blocking = await this.findNonClosedPeriods(yearId);
    if (blocking.length > 0) {
      throw new ConflictException(
        `Cannot submit fiscal year "${year.code}" for closing — the following periods are not closed: ${blocking.map((p) => p.code).join(', ')}.`,
      );
    }
    return this.approvals.submit({
      requestTypeCode: FISCAL_CLOSING_REQUEST_TYPES.yearClose,
      resourceType: 'fiscal_year',
      resourceId: yearId,
      requestedAction: 'close',
      payload: { fiscalYearId: yearId },
      makerUserId: actorUserId,
    });
  }

  private async findNonClosedPeriods(fiscalYearId: string): Promise<Array<{ id: string; code: string; status: string }>> {
    const periods = await this.dataSource.getRepository(FiscalPeriod).find({ where: { fiscalYearId } });
    const withStatus = await Promise.all(
      periods.map(async (p) => ({ id: p.id, code: p.code, status: await this.processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, p.id) })),
    );
    return withStatus.filter((p) => p.status !== 'closed');
  }

  // ---------------------------------------------------------------------------
  // ADR-046 D7 — FA-01 approval subscriber (checker-decided side effect)
  // ---------------------------------------------------------------------------

  private async onApprovalApproved(payload: Record<string, unknown>): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    const approvalRequestId = String(payload.approvalRequestId ?? '');
    const inner = (payload.payload ?? {}) as Record<string, unknown>;

    if (requestTypeCode === FISCAL_CLOSING_REQUEST_TYPES.periodClose) {
      const { snapshotRunId } = await this.applyApprovedPeriodTransition(String(inner.fiscalPeriodId ?? ''), 'close', 'closed', approvalRequestId, true);
      await this.markClosingWorkflowLocked(approvalRequestId);
      if (snapshotRunId) await this.closingSnapshot.assembleAndFinalize(snapshotRunId);
    } else if (requestTypeCode === FISCAL_CLOSING_REQUEST_TYPES.periodReclose) {
      // ADR-051 §1.3 — the reclose path (`reopened -> closed`, action `close_after_reopen`), now
      // FA-01-gated exactly like periodClose (closes the gap the review flagged: no more silent,
      // ungated shortcut through the routine transition endpoint).
      const { snapshotRunId } = await this.applyApprovedPeriodTransition(
        String(inner.fiscalPeriodId ?? ''),
        'close_after_reopen',
        'closed',
        approvalRequestId,
        true,
      );
      await this.markClosingWorkflowLocked(approvalRequestId);
      if (snapshotRunId) await this.closingSnapshot.assembleAndFinalize(snapshotRunId);
    } else if (requestTypeCode === FISCAL_CLOSING_REQUEST_TYPES.periodReopen) {
      await this.applyApprovedPeriodTransition(String(inner.fiscalPeriodId ?? ''), 'reopen', 'reopened', approvalRequestId);
    } else if (requestTypeCode === FISCAL_CLOSING_REQUEST_TYPES.yearClose) {
      await this.applyApprovedYearClose(String(inner.fiscalYearId ?? ''), approvalRequestId);
    }
    // else: not one of F13's request types — not ours, ignore (mirrors F12's FixedAssetDisposalService).
  }

  /**
   * ADR-046 D7 — the defensive subscriber design: (1) check current state
   * FIRST; if it already equals the target, this is a benign duplicate
   * delivery of an already-applied approval — audit a "skip" no-op and
   * return, never an error. (2) Otherwise attempt the real transition; if
   * the Process Engine's own `SELECT ... FOR UPDATE`-backed legality check
   * rejects it (`ConflictException`), re-read the state — if a CONCURRENT
   * duplicate delivery won the race and already applied it, this is the
   * same benign no-op as (1). Only a state that matches neither is a
   * genuine, propagated failure.
   */
  /**
   * `beginSnapshot: true` (ADR-051 §12, only for the periodClose/periodReclose branches) writes the
   * Closing Snapshot's `'pending'` row in the SAME transaction as the transition itself — the return
   * value is that row's id so the caller can run `assembleAndFinalize` immediately after this
   * transaction commits (file I/O cannot safely share this transaction).
   */
  private async applyApprovedPeriodTransition(
    periodId: string,
    action: string,
    targetStatus: string,
    approvalRequestId: string,
    beginSnapshot = false,
  ): Promise<{ snapshotRunId: string | null }> {
    if (!periodId) return { snapshotRunId: null };
    const currentStatus = await this.processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, periodId);
    if (currentStatus === targetStatus) {
      await this.auditSkipAlreadyApplied('fiscal_period', periodId, action, approvalRequestId, currentStatus);
      return { snapshotRunId: null };
    }
    try {
      let snapshotRunId: string | null = null;
      await this.dataSource.transaction(async (manager) => {
        await this.applyPeriodTransition(manager, periodId, action, SYSTEM_ACTOR_ID, approvalRequestId);
        if (beginSnapshot) {
          const run = await this.closingSnapshot.beginPending(manager, periodId, approvalRequestId, SYSTEM_ACTOR_ID);
          snapshotRunId = run.id;
        }
      });
      return { snapshotRunId };
    } catch (err) {
      if (err instanceof ConflictException) {
        const recheck = await this.processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, periodId);
        if (recheck === targetStatus) {
          await this.auditSkipAlreadyApplied('fiscal_period', periodId, action, approvalRequestId, recheck);
          return { snapshotRunId: null };
        }
      }
      throw err;
    }
  }

  /**
   * ADR-046 D10 — decision-time revalidation, race-safe. Every child
   * period's `process_instances` row is locked with the SAME
   * `SELECT ... FOR UPDATE` primitive `ProcessEngineService.transition`
   * itself uses (no new locking mechanism) BEFORE their states are read,
   * inside the SAME transaction that then closes the year. A concurrent
   * period `close`/`reopen` (which locks that exact same row via its own
   * `transition()` call) cannot interleave with this check: it either
   * commits fully before this lock is acquired (seen here, correctly) or
   * blocks until this transaction ends (seen next time, never mid-read).
   */
  private async applyApprovedYearClose(yearId: string, approvalRequestId: string): Promise<void> {
    if (!yearId) return;
    const currentYearStatus = await this.processEngine.getState(FISCAL_YEAR_PROCESS, FISCAL_YEAR_ENTITY_TYPE, yearId);
    if (currentYearStatus === 'closed') {
      await this.auditSkipAlreadyApplied('fiscal_year', yearId, 'close', approvalRequestId, currentYearStatus);
      return;
    }
    try {
      await this.dataSource.transaction(async (manager) => {
        const periods = await manager.getRepository(FiscalPeriod).find({ where: { fiscalYearId: yearId }, order: { id: 'ASC' } });
        const periodIds = periods.map((p) => p.id);
        let lockedRows: Array<{ entityId: string; currentState: string }> = [];
        if (periodIds.length > 0) {
          lockedRows = await manager.query(
            `SELECT "entityId", "currentState" FROM process_instances WHERE "definitionKey" = $1 AND "entityType" = $2 AND "entityId" = ANY($3) ORDER BY "entityId" FOR UPDATE`,
            [FISCAL_PERIOD_PROCESS.key, FISCAL_PERIOD_ENTITY_TYPE, periodIds],
          );
        }
        const lockedStates = new Map(lockedRows.map((r) => [r.entityId, r.currentState]));
        const blocking = periods.filter((p) => lockedStates.get(p.id) !== 'closed');

        if (blocking.length > 0) {
          // The precondition held at submission but no longer holds at decision time (a period was
          // reopened during the approval window) — reject the SIDE EFFECT only; the FA-01 request
          // itself stays "approved" (that record is immutable), but the fiscal year is left
          // completely untouched, mirroring F12's own non-POSTED-audit-without-mutation precedent.
          await this.audit.record(
            {
              actorUserId: SYSTEM_ACTOR_ID,
              organizationId: null,
              action: 'accounting.fiscal_year.close_rejected_period_not_closed',
              resource: 'fiscal_year',
              resourceId: yearId,
              result: 'failure',
              correlationId: approvalRequestId,
              after: { blockingPeriods: blocking.map((p) => p.code) },
            },
            manager,
          );
          return;
        }

        const fromStatus = await this.processEngine.getState(FISCAL_YEAR_PROCESS, FISCAL_YEAR_ENTITY_TYPE, yearId, manager);
        const instance = await this.processEngine.transition(FISCAL_YEAR_PROCESS, FISCAL_YEAR_ENTITY_TYPE, yearId, 'close', SYSTEM_ACTOR_ID, manager);
        const toStatus = instance.currentState;
        await this.audit.record(
          {
            actorUserId: SYSTEM_ACTOR_ID,
            organizationId: null,
            action: 'accounting.fiscal_year.close',
            resource: 'fiscal_year',
            resourceId: yearId,
            result: 'success',
            correlationId: approvalRequestId,
            after: { fromStatus, toStatus },
          },
          manager,
        );
        await this.events.publish(manager, FISCAL_YEAR_STATUS_CHANGED_EVENT, {
          fiscalYearId: yearId,
          fromStatus,
          toStatus,
          actorUserId: SYSTEM_ACTOR_ID,
          businessDate: this.toDateString(new Date()),
        });
      });
    } catch (err) {
      if (err instanceof ConflictException) {
        const recheck = await this.processEngine.getState(FISCAL_YEAR_PROCESS, FISCAL_YEAR_ENTITY_TYPE, yearId);
        if (recheck === 'closed') {
          await this.auditSkipAlreadyApplied('fiscal_year', yearId, 'close', approvalRequestId, recheck);
          return;
        }
      }
      throw err;
    }
  }

  /** ADR-051 §1/§6 — marks this closing attempt's evidence trail complete once the transition has actually applied. Benign no-op if no matching row exists (e.g. a very old approval predating Phase 3). */
  private async markClosingWorkflowLocked(approvalRequestId: string): Promise<void> {
    const repo = this.dataSource.getRepository(ClosingWorkflowRun);
    const run = await repo.findOne({ where: { approvalRequestId } });
    if (!run || run.status === 'period_locked') return;
    run.status = 'period_locked';
    run.completedAt = new Date();
    await repo.save(run);
  }

  private async auditSkipAlreadyApplied(resource: string, resourceId: string, action: string, approvalRequestId: string, status: string): Promise<void> {
    await this.audit.record({
      actorUserId: SYSTEM_ACTOR_ID,
      organizationId: null,
      action: `accounting.${resource}.${action}_skipped_already_applied`,
      resource,
      resourceId,
      result: 'success',
      correlationId: approvalRequestId,
      after: { status },
    });
  }

  /**
   * Blueprint §5 — the precondition contract every future poster (F03,
   * F06, F07, F12) must call before writing anything dated. Resolves the
   * `orgUnitId`-scoped `FiscalYear` first; falls back to the unscoped/
   * global one if no company-scoped year covers `businessDate`.
   *
   * ADR-046 D2 — a `'reopened'` period is now postable, exactly like
   * `'open'` (no change to `FISCAL_PERIOD_PROCESS`'s transition table —
   * `'reopened'` stays a live, distinct, queryable status).
   * ADR-046 D3 — additionally requires the covering `FiscalYear`'s own
   * state be `'active'` (a genuine, previously-unchecked gap: a `'planned'`
   * or `'closed'` year's periods were postable regardless of the year's
   * own status).
   */
  async assertOpenForPosting(orgUnitId: string | null, businessDate: string): Promise<void> {
    const covers = (start: string, end: string) => start <= businessDate && end >= businessDate; // ISO date strings compare lexicographically

    const yearRepo = this.dataSource.getRepository(FiscalYear);
    let year: FiscalYear | undefined;
    if (orgUnitId) {
      const scoped = await yearRepo.find({ where: { orgUnitId } });
      year = scoped.find((y) => covers(y.startDate, y.endDate));
    }
    if (!year) {
      const global = await yearRepo.find({ where: { orgUnitId: IsNull() } });
      year = global.find((y) => covers(y.startDate, y.endDate));
    }
    if (!year) {
      throw new ConflictException(`No fiscal year covers business date "${businessDate}" — posting is not possible.`);
    }

    const yearStatus = await this.processEngine.getState(FISCAL_YEAR_PROCESS, FISCAL_YEAR_ENTITY_TYPE, year.id);
    if (yearStatus !== 'active') {
      throw new ConflictException(`Fiscal year "${year.code}" is "${yearStatus}", not active — posting is not possible.`);
    }

    const periods = await this.dataSource.getRepository(FiscalPeriod).find({ where: { fiscalYearId: year.id } });
    const period = periods.find((p) => covers(p.startDate, p.endDate));
    if (!period) {
      throw new ConflictException(`No fiscal period covers business date "${businessDate}" — posting is not possible.`);
    }

    const status = await this.processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, period.id);
    if (status !== 'open' && status !== 'reopened') {
      throw new ConflictException(`Fiscal period "${period.code}" is "${status}", not open — posting is not possible.`);
    }
  }
}
