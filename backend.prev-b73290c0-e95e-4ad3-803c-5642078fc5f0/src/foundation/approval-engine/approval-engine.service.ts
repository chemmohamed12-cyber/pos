import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, LessThan } from 'typeorm';
import { ApprovalRequestType } from './approval-request-type.entity';
import { ApprovalMatrixRule } from './approval-matrix-rule.entity';
import { ApprovalRequest } from './approval-request.entity';
import { ApprovalDecision } from './approval-decision.entity';
import { APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, ApprovalDecisionValue, ApprovalRequestState } from './approval-process';
import { ProcessEngineService } from '../process-engine/process-engine.service';
import { AuditService } from '../audit/audit.service';
import { EventBusService } from '../events/event-bus.service';
import { PermissionService } from '../permission/permission.service';
import { ConfigurationEngineService } from '../configuration-engine/configuration-engine.service';

export interface SubmitApprovalInput {
  requestTypeCode: string;
  resourceType: string;
  resourceId: string;
  requestedAction: string;
  payload: Record<string, unknown>;
  makerUserId: string;
  orgUnitId?: string | null;
}

export interface UpsertMatrixRuleInput {
  id?: string;
  requestTypeCode: string;
  minApprovers?: number;
  requiredPermissionNode: string;
  valueThreshold?: string | null;
  orgUnitId?: string | null;
  isActive?: boolean;
}

export interface ApprovalRequestView extends ApprovalRequest {
  state: ApprovalRequestState;
  decisions: ApprovalDecision[];
}

/**
 * FA-01 — Generic Approval / Maker-Checker Engine
 * (`architecture/APPROVAL_ENGINE_CONTRACT.md`, ADR-033).
 *
 * Platform-Core, domain-neutral. Knows about "a request, a maker,
 * checkers, a matrix rule" — never about a fiscal period or a payment.
 * Wraps `foundation/process-engine` (one fixed `generic_approval_request`
 * definition); adds maker/checker resolution + the actor-separation
 * invariant on top; hands off to consumers by a pure event
 * (`approval.request.approved`), never a callback.
 *
 * **Zero import from any `src/domains/*`** — enforced by
 * `approval-engine.genericity.spec.ts` (contract §10).
 */
@Injectable()
export class ApprovalEngineService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly permissions: PermissionService,
    private readonly config: ConfigurationEngineService,
  ) {}

  // ---------------------------------------------------------------------------
  // Request-type registry (contract §7 step 1 — analogous to NumberingService)
  // ---------------------------------------------------------------------------

  async registerRequestType(requestTypeCode: string, titleCode: string): Promise<void> {
    const repo = this.dataSource.getRepository(ApprovalRequestType);
    const existing = await repo.findOne({ where: { requestTypeCode } });
    if (existing) {
      if (existing.titleCode !== titleCode) {
        existing.titleCode = titleCode;
        await repo.save(existing);
      }
      return;
    }
    await repo.save(repo.create({ requestTypeCode, titleCode }));
  }

  // ---------------------------------------------------------------------------
  // Matrix-rule administration (contract §3 — standard reference-data CRUD)
  // ---------------------------------------------------------------------------

  async upsertMatrixRule(input: UpsertMatrixRuleInput, actorUserId: string): Promise<ApprovalMatrixRule> {
    if (input.minApprovers !== undefined && input.minApprovers < 1) {
      throw new ConflictException('minApprovers must be at least 1.');
    }
    const typeRepo = this.dataSource.getRepository(ApprovalRequestType);
    if (!(await typeRepo.findOne({ where: { requestTypeCode: input.requestTypeCode } }))) {
      throw new NotFoundException(`Approval request type "${input.requestTypeCode}" is not registered.`);
    }
    const repo = this.dataSource.getRepository(ApprovalMatrixRule);
    // Genuine upsert when `id` is omitted (Open Work Inventory finding, 2026-09-12): every
    // `onModuleInit()`-time caller (FiscalPeriodService, AP/AR/Cash/Fixed-Asset adjustment services)
    // re-registers the SAME rule on every app restart with no `id` to hand back — without a
    // find-before-create step here, each restart silently inserted a fresh, content-identical
    // duplicate row (harmless for `resolveMatrixRule`'s own selection today, since it always chose a
    // duplicate with the same values, but real, unbounded table growth). Matched on the SAME 3-column
    // key `resolveMatrixRule` itself uses to disambiguate rules for one request type — `orgUnitId` and
    // `valueThreshold` are genuinely part of a rule's identity (a scoped or threshold-banded rule must
    // stay a separate row), so matching on `requestTypeCode` alone would wrongly collapse them.
    let rule: ApprovalMatrixRule | null;
    if (input.id) {
      rule = await repo.findOne({ where: { id: input.id } });
      if (!rule) throw new NotFoundException(`Approval matrix rule "${input.id}" not found.`);
    } else {
      rule =
        (await repo.findOne({
          where: {
            requestTypeCode: input.requestTypeCode,
            orgUnitId: input.orgUnitId ?? IsNull(),
            valueThreshold: input.valueThreshold ?? IsNull(),
          },
        })) ?? repo.create({ requestTypeCode: input.requestTypeCode });
    }
    const wasNew = !rule.id;

    rule.requestTypeCode = input.requestTypeCode;
    rule.minApprovers = input.minApprovers ?? rule.minApprovers ?? 1;
    rule.requiredPermissionNode = input.requiredPermissionNode;
    rule.valueThreshold = input.valueThreshold ?? null;
    rule.orgUnitId = input.orgUnitId ?? null;
    rule.isActive = input.isActive ?? rule.isActive ?? true;

    const saved = await repo.save(rule);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: wasNew ? 'approval.matrix_rule.created' : 'approval.matrix_rule.updated',
      resource: 'approval_matrix_rule',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { requestTypeCode: saved.requestTypeCode, minApprovers: saved.minApprovers, requiredPermissionNode: saved.requiredPermissionNode, isActive: saved.isActive },
    });
    return saved;
  }

  async listMatrixRules(requestTypeCode?: string): Promise<ApprovalMatrixRule[]> {
    const repo = this.dataSource.getRepository(ApprovalMatrixRule);
    return repo.find({ where: requestTypeCode ? { requestTypeCode } : {}, order: { requestTypeCode: 'ASC', createdAt: 'ASC' } });
  }

  async listRequestTypes(): Promise<ApprovalRequestType[]> {
    return this.dataSource.getRepository(ApprovalRequestType).find({ order: { requestTypeCode: 'ASC' } });
  }

  // ---------------------------------------------------------------------------
  // submit (contract §7 step 2)
  // ---------------------------------------------------------------------------

  async submit(input: SubmitApprovalInput): Promise<ApprovalRequestView> {
    const typeRepo = this.dataSource.getRepository(ApprovalRequestType);
    if (!(await typeRepo.findOne({ where: { requestTypeCode: input.requestTypeCode } }))) {
      throw new NotFoundException(`Approval request type "${input.requestTypeCode}" is not registered.`);
    }

    const rule = await this.resolveMatrixRule(input.requestTypeCode, input.orgUnitId ?? null, this.amountOf(input.payload));
    const resolvedMinApprovers = rule?.minApprovers ?? 1;
    const resolvedRequiredNode = rule?.requiredPermissionNode ?? input.requestTypeCode;

    const requestId = await this.dataSource.transaction(async (manager) => {
      const reqRepo = manager.getRepository(ApprovalRequest);
      const saved = await reqRepo.save(
        reqRepo.create({
          requestTypeCode: input.requestTypeCode,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          requestedAction: input.requestedAction,
          payload: input.payload,
          makerUserId: input.makerUserId,
          orgUnitId: input.orgUnitId ?? null,
          resolvedMinApprovers,
          resolvedRequiredNode,
          processInstanceId: null,
          decidedAt: null,
        }),
      );
      const instance = await this.processEngine.start(APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, saved.id, manager);
      saved.processInstanceId = instance.id;
      await reqRepo.save(saved);

      await this.audit.record(
        {
          actorUserId: input.makerUserId,
          organizationId: null,
          action: 'approval.request.submitted',
          resource: 'approval_request',
          resourceId: saved.id,
          result: 'success',
          correlationId: saved.id,
          after: { requestTypeCode: input.requestTypeCode, resourceType: input.resourceType, resourceId: input.resourceId, resolvedMinApprovers, resolvedRequiredNode },
        },
        manager,
      );
      return saved.id;
    });

    return this.getRequest(requestId);
  }

  // ---------------------------------------------------------------------------
  // decide (contract §7 step 3 + §5 invariants + §6 any-of-N / terminal reject)
  // ---------------------------------------------------------------------------

  async decide(
    requestId: string,
    approverUserId: string,
    decision: ApprovalDecisionValue,
    note?: string | null,
  ): Promise<ApprovalRequestView> {
    let becameApproved = false;
    let becameRejected = false;
    let approvedPayload: { request: ApprovalRequest } | null = null;

    await this.dataSource.transaction(async (manager) => {
      const request = await this.lockRequest(manager, requestId);
      if (!request) throw new NotFoundException(`Approval request "${requestId}" not found.`);

      const state = (await this.processEngine.getState(
        APPROVAL_PROCESS,
        APPROVAL_REQUEST_ENTITY_TYPE,
        requestId,
        manager,
      )) as ApprovalRequestState;
      if (state !== 'pending') {
        throw new ConflictException(`Approval request is "${state}", not pending — no further decisions accepted.`);
      }

      // Contract §5.1 — maker can never be a checker. Fail closed.
      if (approverUserId === request.makerUserId) {
        throw new ForbiddenException('The maker of an approval request cannot approve or reject it (segregation of duties).');
      }

      // Contract §6 — checker eligibility resolved LIVE, not cached.
      const eligible = await this.permissions.hasAtLeast(approverUserId, request.resolvedRequiredNode, 'editable');
      if (!eligible) {
        throw new ForbiddenException(
          `Not authorized to decide this approval request (requires "${request.resolvedRequiredNode}" at editable).`,
        );
      }

      const decRepo = manager.getRepository(ApprovalDecision);
      try {
        await decRepo.save(
          decRepo.create({ approvalRequestId: requestId, approverUserId, decision, note: note ?? null }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/duplicate key value violates unique constraint/i.test(msg)) {
          throw new ConflictException('You have already recorded a decision on this approval request.');
        }
        throw err;
      }

      if (decision === 'rejected') {
        // Contract §6 — rejection is terminal and immediate.
        await this.processEngine.transition(APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, requestId, 'reject', approverUserId, manager);
        await manager.getRepository(ApprovalRequest).update({ id: requestId }, { decidedAt: new Date() });
        await this.events.publish(manager, 'approval.request.rejected', {
          approvalRequestId: requestId,
          requestTypeCode: request.requestTypeCode,
          resourceType: request.resourceType,
          resourceId: request.resourceId,
        });
        becameRejected = true;
      } else {
        // Contract §6 — any-of-N: approve once N distinct 'approved' decisions exist.
        const rows: Array<{ n: string }> = await manager.query(
          `SELECT count(*)::int AS n FROM approval_decisions WHERE "approvalRequestId" = $1 AND decision = 'approved'`,
          [requestId],
        );
        const approvedCount = Number(rows[0].n);
        if (approvedCount >= request.resolvedMinApprovers) {
          await this.processEngine.transition(APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, requestId, 'approve', approverUserId, manager);
          await manager.getRepository(ApprovalRequest).update({ id: requestId }, { decidedAt: new Date() });
          await this.events.publish(manager, 'approval.request.approved', {
            approvalRequestId: requestId,
            requestTypeCode: request.requestTypeCode,
            resourceType: request.resourceType,
            resourceId: request.resourceId,
            requestedAction: request.requestedAction,
            payload: request.payload,
          });
          becameApproved = true;
          approvedPayload = { request };
        }
      }

      await this.audit.record(
        {
          actorUserId: approverUserId,
          organizationId: null,
          action: `approval.request.${decision}`,
          resource: 'approval_request',
          resourceId: requestId,
          result: 'success',
          correlationId: requestId,
          after: { decision, becameApproved, becameRejected },
        },
        manager,
      );
    });

    void approvedPayload;
    await this.events.dispatchPending();
    return this.getRequest(requestId);
  }

  // ---------------------------------------------------------------------------
  // withdraw (contract §4 — maker-only) / escalate (manual, V1) / expire (sweep)
  // ---------------------------------------------------------------------------

  async withdraw(requestId: string, actorUserId: string): Promise<ApprovalRequestView> {
    await this.dataSource.transaction(async (manager) => {
      const request = await this.lockRequest(manager, requestId);
      if (!request) throw new NotFoundException(`Approval request "${requestId}" not found.`);
      if (actorUserId !== request.makerUserId) {
        throw new ForbiddenException('Only the maker who submitted a request may withdraw it.');
      }
      await this.processEngine.transition(APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, requestId, 'withdraw', actorUserId, manager);
      await manager.getRepository(ApprovalRequest).update({ id: requestId }, { decidedAt: new Date() });
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'approval.request.withdrawn', resource: 'approval_request', resourceId: requestId, result: 'success', correlationId: requestId },
        manager,
      );
    });
    return this.getRequest(requestId);
  }

  async escalate(requestId: string, actorUserId: string): Promise<ApprovalRequestView> {
    await this.dataSource.transaction(async (manager) => {
      const request = await this.lockRequest(manager, requestId);
      if (!request) throw new NotFoundException(`Approval request "${requestId}" not found.`);
      await this.processEngine.transition(APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, requestId, 'escalate', actorUserId, manager);
      await manager.getRepository(ApprovalRequest).update({ id: requestId }, { decidedAt: new Date() });
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'approval.request.escalated', resource: 'approval_request', resourceId: requestId, result: 'success', correlationId: requestId },
        manager,
      );
    });
    return this.getRequest(requestId);
  }

  /** Called only by the scheduled sweep. Transitions every stale `pending` request to `expired`. */
  async expire(): Promise<{ expired: number }> {
    const ttlHours = this.config.get<number>('core.approval.request_ttl_hours');
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000);
    const stale = await this.dataSource
      .getRepository(ApprovalRequest)
      .find({ where: { createdAt: LessThan(cutoff), decidedAt: IsNull() } });

    let expired = 0;
    for (const request of stale) {
      try {
        await this.dataSource.transaction(async (manager) => {
          const state = (await this.processEngine.getState(
            APPROVAL_PROCESS,
            APPROVAL_REQUEST_ENTITY_TYPE,
            request.id,
            manager,
          )) as ApprovalRequestState;
          if (state !== 'pending') return;
          await this.processEngine.transition(APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, request.id, 'expire', null, manager);
          await manager.getRepository(ApprovalRequest).update({ id: request.id }, { decidedAt: new Date() });
          await this.events.publish(manager, 'approval.request.expired', {
            approvalRequestId: request.id,
            requestTypeCode: request.requestTypeCode,
          });
          await this.audit.record(
            { actorUserId: null, organizationId: null, action: 'approval.request.expired', resource: 'approval_request', resourceId: request.id, result: 'success', correlationId: request.id },
            manager,
          );
          expired += 1;
        });
      } catch {
        // a concurrent decision won the race — fine, skip it
      }
    }
    if (expired > 0) await this.events.dispatchPending();
    return { expired };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async getRequest(requestId: string): Promise<ApprovalRequestView> {
    const request = await this.dataSource.getRepository(ApprovalRequest).findOne({ where: { id: requestId } });
    if (!request) throw new NotFoundException(`Approval request "${requestId}" not found.`);
    const state = (await this.processEngine.getState(APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, requestId)) as ApprovalRequestState;
    const decisions = await this.dataSource
      .getRepository(ApprovalDecision)
      .find({ where: { approvalRequestId: requestId }, order: { decidedAt: 'ASC' } });
    return { ...request, state, decisions };
  }

  async listRequests(filter?: { requestTypeCode?: string; makerUserId?: string; resourceType?: string; resourceId?: string }): Promise<ApprovalRequest[]> {
    const where: Record<string, unknown> = {};
    if (filter?.requestTypeCode) where.requestTypeCode = filter.requestTypeCode;
    if (filter?.makerUserId) where.makerUserId = filter.makerUserId;
    if (filter?.resourceType) where.resourceType = filter.resourceType;
    if (filter?.resourceId) where.resourceId = filter.resourceId;
    return this.dataSource.getRepository(ApprovalRequest).find({ where, order: { createdAt: 'DESC' } });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Blueprint §4.2 — among active rules for the type whose scope is NULL
   * or matches the request's, and whose `valueThreshold` is NULL or
   * `<= amount`, pick the most specific / highest-threshold match. No
   * match → `null` (caller defaults to minApprovers = 1, node = the type
   * code itself).
   */
  private async resolveMatrixRule(
    requestTypeCode: string,
    orgUnitId: string | null,
    amount: number,
  ): Promise<ApprovalMatrixRule | null> {
    const rules = await this.dataSource
      .getRepository(ApprovalMatrixRule)
      .find({ where: { requestTypeCode, isActive: true } });

    const applicable = rules.filter((r) => {
      const scopeOk = r.orgUnitId === null || r.orgUnitId === orgUnitId;
      const thresholdOk = r.valueThreshold === null || amount >= Number(r.valueThreshold);
      return scopeOk && thresholdOk;
    });
    if (applicable.length === 0) return null;

    applicable.sort((a, b) => {
      // scoped rule beats global
      const scopeRank = (r: ApprovalMatrixRule) => (r.orgUnitId === null ? 0 : 1);
      if (scopeRank(b) !== scopeRank(a)) return scopeRank(b) - scopeRank(a);
      // higher threshold beats lower (more specific escalation band)
      const t = (r: ApprovalMatrixRule) => (r.valueThreshold === null ? -1 : Number(r.valueThreshold));
      if (t(b) !== t(a)) return t(b) - t(a);
      // finally the stricter rule
      return b.minApprovers - a.minApprovers;
    });
    return applicable[0];
  }

  private amountOf(payload: Record<string, unknown>): number {
    const raw = payload?.amount;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : 0;
  }

  private async lockRequest(manager: EntityManager, id: string): Promise<ApprovalRequest | null> {
    const rows = await manager.getRepository(ApprovalRequest).find({ where: { id }, lock: { mode: 'pessimistic_write' } });
    return rows[0] ?? null;
  }
}
