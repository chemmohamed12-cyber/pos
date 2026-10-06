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
  /**
   * Area 21 (2026-10-05, CTO: Approval is Company-scoped — Matrix §2.2/§49's recommended option).
   * Every public method takes an optional trailing `manager`. With none, behaviour is exactly the
   * previous ambient/Platform one. With a Company `manager` (`req.companyContext.dataSource.manager`,
   * or a transaction manager derived from it) requests, decisions and rules are read and written in
   * THAT Company's own database, permissions resolve against that Company's roles, and the events
   * land in that Company's outbox.
   *
   * The request-type registry and the default matrix rules are DECLARED in code at boot
   * (`registerRequestType` / the services' `upsertMatrixRule` calls in `onModuleInit`). A Company's own
   * database is brought in line with that declaration the first time the engine is used with its
   * manager (`ensureCompanyCatalog`): missing types and rules are inserted, nothing the Company has
   * customised is ever overwritten. This also covers Companies provisioned before this change.
   */
  private readonly declaredTypes = new Map<string, string>();
  private readonly declaredRules: UpsertMatrixRuleInput[] = [];
  private readonly catalogSync = new WeakMap<DataSource, Promise<void>>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly permissions: PermissionService,
    private readonly config: ConfigurationEngineService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  /** True when the manager belongs to a Company connection (not the ambient one). */
  private isCompany(manager?: EntityManager): manager is EntityManager {
    return !!manager && manager.connection !== this.dataSource;
  }

  /** Bring a Company's own approval catalog in line with the code-declared one (idempotent, serialized per connection, committed independently of the caller's transaction). */
  private async ensureCompanyCatalog(manager?: EntityManager): Promise<void> {
    if (!this.isCompany(manager)) return;
    const connection = manager.connection;
    let pending = this.catalogSync.get(connection);
    if (!pending) {
      pending = this.syncCatalog(connection.manager).catch((err) => {
        this.catalogSync.delete(connection); // retry on the next use
        throw err;
      });
      this.catalogSync.set(connection, pending);
    }
    await pending;
  }

  private async syncCatalog(root: EntityManager): Promise<void> {
    const types = root.getRepository(ApprovalRequestType);
    for (const [requestTypeCode, titleCode] of this.declaredTypes) {
      const existing = await types.findOne({ where: { requestTypeCode } });
      if (!existing) await types.save(types.create({ requestTypeCode, titleCode }));
      else if (existing.titleCode !== titleCode) await types.save({ ...existing, titleCode });
    }
    const rules = root.getRepository(ApprovalMatrixRule);
    for (const r of this.declaredRules) {
      const exists = await rules.findOne({
        where: { requestTypeCode: r.requestTypeCode, orgUnitId: r.orgUnitId ?? IsNull(), valueThreshold: r.valueThreshold ?? IsNull() },
      });
      if (exists) continue; // a Company's own rule always wins
      await rules.save(
        rules.create({
          requestTypeCode: r.requestTypeCode,
          minApprovers: r.minApprovers ?? 1,
          requiredPermissionNode: r.requiredPermissionNode,
          valueThreshold: r.valueThreshold ?? null,
          orgUnitId: r.orgUnitId ?? null,
          isActive: r.isActive ?? true,
        }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Request-type registry (contract §7 step 1 — analogous to NumberingService)
  // ---------------------------------------------------------------------------

  async registerRequestType(requestTypeCode: string, titleCode: string): Promise<void> {
    this.declaredTypes.set(requestTypeCode, titleCode);
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

  async upsertMatrixRule(input: UpsertMatrixRuleInput, actorUserId: string, manager?: EntityManager): Promise<ApprovalMatrixRule> {
    if (input.minApprovers !== undefined && input.minApprovers < 1) {
      throw new ConflictException('minApprovers must be at least 1.');
    }
    // A manager-less call without an id is the boot-time DECLARATION of a default rule (services call this from
    // onModuleInit): remember it so each Company's own catalog can be brought in line. A call WITH a Company
    // manager is that Company's own edit and is never remembered.
    if (!manager && !input.id) this.declaredRules.push({ ...input });
    await this.ensureCompanyCatalog(manager);
    const typeRepo = this.em(manager).getRepository(ApprovalRequestType);
    if (!(await typeRepo.findOne({ where: { requestTypeCode: input.requestTypeCode } }))) {
      throw new NotFoundException(`Approval request type "${input.requestTypeCode}" is not registered.`);
    }
    const repo = this.em(manager).getRepository(ApprovalMatrixRule);
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
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: wasNew ? 'approval.matrix_rule.created' : 'approval.matrix_rule.updated',
        resource: 'approval_matrix_rule',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after: { requestTypeCode: saved.requestTypeCode, minApprovers: saved.minApprovers, requiredPermissionNode: saved.requiredPermissionNode, isActive: saved.isActive },
      },
      manager,
    );
    return saved;
  }

  async listMatrixRules(requestTypeCode?: string, manager?: EntityManager): Promise<ApprovalMatrixRule[]> {
    await this.ensureCompanyCatalog(manager);
    const repo = this.em(manager).getRepository(ApprovalMatrixRule);
    return repo.find({ where: requestTypeCode ? { requestTypeCode } : {}, order: { requestTypeCode: 'ASC', createdAt: 'ASC' } });
  }

  async listRequestTypes(manager?: EntityManager): Promise<ApprovalRequestType[]> {
    await this.ensureCompanyCatalog(manager);
    return this.em(manager).getRepository(ApprovalRequestType).find({ order: { requestTypeCode: 'ASC' } });
  }

  // ---------------------------------------------------------------------------
  // submit (contract §7 step 2)
  // ---------------------------------------------------------------------------

  async submit(input: SubmitApprovalInput, manager?: EntityManager): Promise<ApprovalRequestView> {
    await this.ensureCompanyCatalog(manager);
    const typeRepo = this.em(manager).getRepository(ApprovalRequestType);
    if (!(await typeRepo.findOne({ where: { requestTypeCode: input.requestTypeCode } }))) {
      throw new NotFoundException(`Approval request type "${input.requestTypeCode}" is not registered.`);
    }

    const rule = await this.resolveMatrixRule(input.requestTypeCode, input.orgUnitId ?? null, this.amountOf(input.payload), manager);
    const resolvedMinApprovers = rule?.minApprovers ?? 1;
    const resolvedRequiredNode = rule?.requiredPermissionNode ?? input.requestTypeCode;

    const requestId = await this.em(manager).transaction(async (tx) => {
      const reqRepo = tx.getRepository(ApprovalRequest);
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
      const instance = await this.processEngine.start(APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, saved.id, tx);
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
        tx,
      );
      return saved.id;
    });

    return this.getRequest(requestId, manager);
  }

  // ---------------------------------------------------------------------------
  // decide (contract §7 step 3 + §5 invariants + §6 any-of-N / terminal reject)
  // ---------------------------------------------------------------------------

  async decide(
    requestId: string,
    approverUserId: string,
    decision: ApprovalDecisionValue,
    note?: string | null,
    manager?: EntityManager,
  ): Promise<ApprovalRequestView> {
    let becameApproved = false;
    let becameRejected = false;
    let approvedPayload: { request: ApprovalRequest } | null = null;

    await this.em(manager).transaction(async (tx) => {
      const request = await this.lockRequest(tx, requestId);
      if (!request) throw new NotFoundException(`Approval request "${requestId}" not found.`);

      const state = (await this.processEngine.getState(
        APPROVAL_PROCESS,
        APPROVAL_REQUEST_ENTITY_TYPE,
        requestId,
        tx,
      )) as ApprovalRequestState;
      if (state !== 'pending') {
        throw new ConflictException(`Approval request is "${state}", not pending — no further decisions accepted.`);
      }

      // Contract §5.1 — maker can never be a checker. Fail closed.
      if (approverUserId === request.makerUserId) {
        throw new ForbiddenException('The maker of an approval request cannot approve or reject it (segregation of duties).');
      }

      // Contract §6 — checker eligibility resolved LIVE, not cached.
      // Company flow: the approver's authority is resolved against THAT Company's roles/grants.
      const eligible = await this.permissions.hasAtLeast(approverUserId, request.resolvedRequiredNode, 'editable', manager ? tx : undefined);
      if (!eligible) {
        throw new ForbiddenException(
          `Not authorized to decide this approval request (requires "${request.resolvedRequiredNode}" at editable).`,
        );
      }

      const decRepo = tx.getRepository(ApprovalDecision);
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
        await this.processEngine.transition(APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, requestId, 'reject', approverUserId, tx);
        await tx.getRepository(ApprovalRequest).update({ id: requestId }, { decidedAt: new Date() });
        await this.events.publish(tx, 'approval.request.rejected', {
          approvalRequestId: requestId,
          requestTypeCode: request.requestTypeCode,
          resourceType: request.resourceType,
          resourceId: request.resourceId,
        });
        becameRejected = true;
      } else {
        // Contract §6 — any-of-N: approve once N distinct 'approved' decisions exist.
        const rows: Array<{ n: string }> = await tx.query(
          `SELECT count(*)::int AS n FROM approval_decisions WHERE "approvalRequestId" = $1 AND decision = 'approved'`,
          [requestId],
        );
        const approvedCount = Number(rows[0].n);
        if (approvedCount >= request.resolvedMinApprovers) {
          await this.processEngine.transition(APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, requestId, 'approve', approverUserId, tx);
          await tx.getRepository(ApprovalRequest).update({ id: requestId }, { decidedAt: new Date() });
          await this.events.publish(tx, 'approval.request.approved', {
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
        tx,
      );
    });

    void approvedPayload;
    // Ambient: unchanged. Company: flush THAT Company's outbox with its own manager (a no-op inside a caller's transaction).
    if (manager) await this.events.dispatchAfterCommit(manager);
    else await this.events.dispatchPending();
    return this.getRequest(requestId, manager);
  }

  // ---------------------------------------------------------------------------
  // withdraw (contract §4 — maker-only) / escalate (manual, V1) / expire (sweep)
  // ---------------------------------------------------------------------------

  async withdraw(requestId: string, actorUserId: string, manager?: EntityManager): Promise<ApprovalRequestView> {
    await this.em(manager).transaction(async (tx) => {
      const request = await this.lockRequest(tx, requestId);
      if (!request) throw new NotFoundException(`Approval request "${requestId}" not found.`);
      if (actorUserId !== request.makerUserId) {
        throw new ForbiddenException('Only the maker who submitted a request may withdraw it.');
      }
      await this.processEngine.transition(APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, requestId, 'withdraw', actorUserId, tx);
      await tx.getRepository(ApprovalRequest).update({ id: requestId }, { decidedAt: new Date() });
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'approval.request.withdrawn', resource: 'approval_request', resourceId: requestId, result: 'success', correlationId: requestId },
        tx,
      );
    });
    return this.getRequest(requestId, manager);
  }

  async escalate(requestId: string, actorUserId: string, manager?: EntityManager): Promise<ApprovalRequestView> {
    await this.em(manager).transaction(async (tx) => {
      const request = await this.lockRequest(tx, requestId);
      if (!request) throw new NotFoundException(`Approval request "${requestId}" not found.`);
      await this.processEngine.transition(APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, requestId, 'escalate', actorUserId, tx);
      await tx.getRepository(ApprovalRequest).update({ id: requestId }, { decidedAt: new Date() });
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'approval.request.escalated', resource: 'approval_request', resourceId: requestId, result: 'success', correlationId: requestId },
        tx,
      );
    });
    return this.getRequest(requestId, manager);
  }

  /**
   * Called only by the scheduled sweep. Transitions every stale `pending`
   * request to `expired`.
   *
   * Multi-Company Area 9 (2026-09-22) — `dataSource?` added so
   * `ApprovalExpiryScheduler` can call this once per Company against that
   * Company's own connection instead of the single ambient one. Falls back
   * to the ambient `this.dataSource` when omitted (current/default
   * behavior, unchanged). Note the `ttlHours` config value itself still
   * comes from `ConfigurationEngineService`'s platform-wide cache, not a
   * per-Company value — Configuration Engine is not part of this Area 9
   * fix and is out of scope here.
   */
  async expire(dataSource?: DataSource): Promise<{ expired: number }> {
    const ds = dataSource ?? this.dataSource;
    const ttlHours = this.config.get<number>('core.approval.request_ttl_hours');
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000);
    const stale = await ds
      .getRepository(ApprovalRequest)
      .find({ where: { createdAt: LessThan(cutoff), decidedAt: IsNull() } });

    let expired = 0;
    for (const request of stale) {
      try {
        await ds.transaction(async (manager) => {
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
    if (expired > 0) await this.events.dispatchPending(50, dataSource ? ds.manager : undefined);
    return { expired };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async getRequest(requestId: string, manager?: EntityManager): Promise<ApprovalRequestView> {
    const request = await this.em(manager).getRepository(ApprovalRequest).findOne({ where: { id: requestId } });
    if (!request) throw new NotFoundException(`Approval request "${requestId}" not found.`);
    const state = (await this.processEngine.getState(APPROVAL_PROCESS, APPROVAL_REQUEST_ENTITY_TYPE, requestId, manager)) as ApprovalRequestState;
    const decisions = await this.em(manager)
      .getRepository(ApprovalDecision)
      .find({ where: { approvalRequestId: requestId }, order: { decidedAt: 'ASC' } });
    return { ...request, state, decisions };
  }

  async listRequests(
    filter?: { requestTypeCode?: string; makerUserId?: string; resourceType?: string; resourceId?: string },
    manager?: EntityManager,
  ): Promise<ApprovalRequest[]> {
    const where: Record<string, unknown> = {};
    if (filter?.requestTypeCode) where.requestTypeCode = filter.requestTypeCode;
    if (filter?.makerUserId) where.makerUserId = filter.makerUserId;
    if (filter?.resourceType) where.resourceType = filter.resourceType;
    if (filter?.resourceId) where.resourceId = filter.resourceId;
    return this.em(manager).getRepository(ApprovalRequest).find({ where, order: { createdAt: 'DESC' } });
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
    manager?: EntityManager,
  ): Promise<ApprovalMatrixRule | null> {
    const rules = await this.em(manager)
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
