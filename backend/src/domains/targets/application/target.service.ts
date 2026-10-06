import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Target } from '../infrastructure/target.entity';
import { TARGET_PROCESS_KEY } from '../domain/target-status';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';
import { HrService } from '../../hr/application/hr.service';

const APPROVAL_TYPE = 'targets.target_approval';
const APPROVER_NODE = 'targets.target.approve';
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const ENTITY_TYPE = 'Target';

/** ADR-071 §6 — `draft -> pending_approval -> approved | rejected`, driven by `ProcessEngineService`. */
export const TARGET_PROCESS: ProcessDefinition = {
  key: TARGET_PROCESS_KEY,
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'pending_approval', action: 'submit' },
    { from: 'pending_approval', to: 'approved', action: 'approve' },
    { from: 'pending_approval', to: 'rejected', action: 'reject' },
  ],
};

export interface CreateTargetInput {
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  targetValue: string;
  teamId?: string | null;
}

/**
 * ADR-071 §4/§6 — Target Management application service. `Employee` +
 * `Target Period` are mandatory (ADR-068 §D); non-overlap for approved
 * targets is enforced at the DB level (the migration's own EXCLUDE
 * constraint), never re-implemented in application code as the sole guard.
 */
@Injectable()
export class TargetService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly approvals: ApprovalEngineService,
    private readonly processEngine: ProcessEngineService,
    private readonly hr: HrService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async onModuleInit(): Promise<void> {
    await this.approvals.registerRequestType(APPROVAL_TYPE, 'action.targets_submit_approval');
    await this.approvals
      .upsertMatrixRule({ requestTypeCode: APPROVAL_TYPE, minApprovers: 1, requiredPermissionNode: APPROVER_NODE, valueThreshold: null, orgUnitId: null }, SYSTEM_ACTOR_ID)
      .catch(() => undefined);

    // Company scope (ADR-075): runs for the Company outbox the event was published in (ctx.manager); unchanged for the ambient one.
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

  async create(input: CreateTargetInput, actorUserId: string, manager?: EntityManager): Promise<Target> {
    await this.hr.getEmployee(input.employeeId, manager); // throws NotFoundException if the employee does not exist
    if (input.periodStart > input.periodEnd) throw new ConflictException('periodStart must be on or before periodEnd.');
    if (!(Number(input.targetValue) > 0)) throw new ConflictException('targetValue must be positive.');

    const repo = this.em(manager).getRepository(Target);
    const saved = await repo.save(
      repo.create({
        employeeId: input.employeeId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        targetValue: input.targetValue,
        teamId: input.teamId ?? null,
        status: 'draft',
        createdByUserId: actorUserId,
      }),
    );
    await this.processEngine.start(TARGET_PROCESS, ENTITY_TYPE, saved.id, manager);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'targets.target.created',
        resource: 'target',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after: { employeeId: input.employeeId, periodStart: input.periodStart, periodEnd: input.periodEnd, targetValue: input.targetValue },
      },
      manager,
    );
    return saved;
  }

  async listTargets(employeeId?: string, manager?: EntityManager): Promise<Target[]> {
    return this.em(manager).getRepository(Target).find({ where: employeeId ? { employeeId } : {}, order: { periodStart: 'DESC' } });
  }

  /** The one read Commission's Resolution Engine needs (ADR-071 §9) — the Approved Target covering a given date, if any. */
  async getApprovedTargetForDate(employeeId: string, date: string, manager?: EntityManager): Promise<Target | null> {
    const targets = await this.em(manager).getRepository(Target).find({ where: { employeeId, status: 'approved' } });
    return targets.find((t) => t.periodStart <= date && t.periodEnd >= date) ?? null;
  }

  async submitForApproval(targetId: string, actorUserId: string, manager?: EntityManager): Promise<Target> {
    const repo = this.em(manager).getRepository(Target);
    const target = await repo.findOne({ where: { id: targetId } });
    if (!target) throw new NotFoundException(`Target "${targetId}" not found.`);

    const approvalRequest = await this.approvals.submit(
      {
        requestTypeCode: APPROVAL_TYPE,
        resourceType: ENTITY_TYPE,
        resourceId: targetId,
        requestedAction: 'approve',
        payload: { employeeId: target.employeeId, periodStart: target.periodStart, periodEnd: target.periodEnd, targetValue: target.targetValue },
        makerUserId: actorUserId,
      },
      manager,
    );

    await this.processEngine.transition(TARGET_PROCESS, ENTITY_TYPE, targetId, 'submit', actorUserId, manager);
    target.status = 'pending_approval';
    target.approvalRequestId = approvalRequest.id;
    const saved = await repo.save(target);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'targets.target.submitted',
        resource: 'target',
        resourceId: targetId,
        result: 'success',
        correlationId: approvalRequest.id,
      },
      manager,
    );
    return saved;
  }

  /** Pure pass-through to the generic engine — same shape as every other FA-01 consumer's own `decide`. */
  async decide(requestId: string, approverUserId: string, decision: 'approved' | 'rejected', note?: string | null, manager?: EntityManager): Promise<unknown> {
    return this.approvals.decide(requestId, approverUserId, decision, note ?? null, manager);
  }

  private async onApprovalApproved(payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (requestTypeCode !== APPROVAL_TYPE) return;
    const resourceId = String(payload.resourceId ?? '');
    const target = await this.em(manager).getRepository(Target).findOne({ where: { id: resourceId } });
    if (!target || target.status === 'approved') return; // not found, or already applied — benign no-op

    // Same decoupling risk the CTO caught in Payroll's own P0 review: without a shared
    // transaction, a DB-level rejection of the Target save (e.g. the non-overlap EXCLUDE
    // constraint) would leave ProcessEngine's own state at 'approved' while Target.status stayed
    // behind — a state desync, not merely a failed write. Atomic, matching PayrollService's own
    // proven `onApprovalApproved` shape.
    await this.em(manager).transaction(async (tx) => {
      await this.processEngine.transition(TARGET_PROCESS, ENTITY_TYPE, target.id, 'approve', SYSTEM_ACTOR_ID, tx);
      target.status = 'approved';
      target.approvedAt = new Date();
      await tx.getRepository(Target).save(target);
    });
    await this.audit.record(
      {
        actorUserId: SYSTEM_ACTOR_ID,
        organizationId: null,
        action: 'targets.target.approved',
        resource: 'target',
        resourceId: target.id,
        result: 'success',
        correlationId: String(payload.approvalRequestId ?? ''),
      },
      manager,
    );
  }

  private async onApprovalRejected(payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (requestTypeCode !== APPROVAL_TYPE) return;
    const resourceId = String(payload.resourceId ?? '');
    const target = await this.em(manager).getRepository(Target).findOne({ where: { id: resourceId } });
    if (!target || target.status === 'rejected') return;

    await this.em(manager).transaction(async (tx) => {
      await this.processEngine.transition(TARGET_PROCESS, ENTITY_TYPE, target.id, 'reject', SYSTEM_ACTOR_ID, tx);
      target.status = 'rejected';
      await tx.getRepository(Target).save(target);
    });
  }
}
