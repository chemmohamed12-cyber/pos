import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, IsNull, EntityManager } from 'typeorm';
import { CommissionPolicy } from '../infrastructure/commission-policy.entity';
import { CommissionTier } from '../infrastructure/commission-tier.entity';
import { CommissionApprovalBatch } from '../infrastructure/commission-approval-batch.entity';
import { CommissionResult } from '../infrastructure/commission-result.entity';
import { CommissionAdjustment } from '../infrastructure/commission-adjustment.entity';
import { COMMISSION_BATCH_PROCESS_KEY, CommissionAdjustmentKind, CommissionBasis, CommissionPolicyScope, CommissionRateModel } from '../domain/commission-status';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';
import { HrService } from '../../hr/application/hr.service';
import { TargetService } from '../../targets/application/target.service';

const APPROVAL_TYPE = 'commission.batch_approval';
const APPROVER_NODE = 'commission.batch.approve';
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const BATCH_ENTITY_TYPE = 'CommissionApprovalBatch';

/** ADR-071 §6 — mirrors Attendance's own proven batch shape (ADR-069 §1) exactly, driven by `ProcessEngineService`. */
export const COMMISSION_BATCH_PROCESS: ProcessDefinition = {
  key: COMMISSION_BATCH_PROCESS_KEY,
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'submitted', action: 'submit' },
    { from: 'submitted', to: 'approved', action: 'approve' },
    { from: 'submitted', to: 'rejected', action: 'reject' },
  ],
};

export interface CreateTierInput {
  tierOrder: number;
  fromPercent: string;
  toPercent: string | null;
  rate: string;
}

export interface CreatePolicyInput {
  scope: CommissionPolicyScope;
  scopeRefId: string;
  basis: CommissionBasis;
  rateModel: CommissionRateModel;
  flatRate?: string | null;
  tiers?: CreateTierInput[];
}

export interface CreateAdjustmentInput {
  originalCommissionResultId: string;
  kind: CommissionAdjustmentKind;
  reason: string;
  amountDelta: string;
}

/**
 * ADR-068/ADR-071 — Commission Phase 1 application service: the
 * Resolution Engine (never an inline `if customerRate else repRate`
 * chain — a dedicated, named resolution step), the calculation pipeline
 * (event-driven off the existing `finance.invoice.posted`/
 * `collection.remitted` topics, never a new event Commission invents),
 * and the immutable-snapshot `CommissionResult` (ADR-068 §F).
 */
@Injectable()
export class CommissionService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly approvals: ApprovalEngineService,
    private readonly processEngine: ProcessEngineService,
    private readonly hr: HrService,
    private readonly targets: TargetService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  /** Area 21: repositories bound to the caller's connection — the Company's own when a Company `manager` is passed, the ambient one otherwise. */
  private repos(manager?: EntityManager) {
    const em = this.em(manager);
    return {
      policies: em.getRepository(CommissionPolicy),
      tiers: em.getRepository(CommissionTier),
      batches: em.getRepository(CommissionApprovalBatch),
      results: em.getRepository(CommissionResult),
      adjustments: em.getRepository(CommissionAdjustment),
    };
  }

  async onModuleInit(): Promise<void> {
    await this.approvals.registerRequestType(APPROVAL_TYPE, 'action.commission_submit_approval');
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

    // ADR-071 §9 — the existing, already-consumed Financial Event topics, never a new event
    // Commission invents. 'collection.recorded' is deliberately NOT subscribed here, mirroring
    // F03's own convention (handler-registry.ts) that topic stays permanently-ignored-by-design —
    // 'collection.remitted' is the one real GL/business trigger for a collection.
    this.events.subscribe(
    'finance.invoice.posted',
    async (payload, ctx) => {
      await this.onInvoicePosted(payload as Record<string, unknown>, ctx.manager ?? undefined);
    },
    { scope: 'company' },
  );
    this.events.subscribe(
    'collection.remitted',
    async (payload, ctx) => {
      await this.onCollectionRemitted(payload as Record<string, unknown>, ctx.manager ?? undefined);
    },
    { scope: 'company' },
  );
  }

  // ---------------------------------------------------------------------------
  // Policy — ADR-068 §A/§2/§3. Effective-dated, new row per change.
  // ---------------------------------------------------------------------------

  async createPolicy(input: CreatePolicyInput, actorUserId: string, manager?: EntityManager): Promise<CommissionPolicy> {
    if (input.rateModel === 'flat' && !input.flatRate) throw new ConflictException('flatRate is required when rateModel is "flat".');
    if (input.rateModel === 'target_tiered' && (!input.tiers || input.tiers.length === 0)) {
      throw new ConflictException('At least one tier is required when rateModel is "target_tiered".');
    }
    if (input.scope === 'sales_rep') {
      await this.hr.getEmployee(input.scopeRefId, manager); // throws NotFoundException if not a real Employee (ADR-068 §G — never a User id)
    }

    return this.em(manager).transaction(async (manager) => {
      const existingActive = await manager
        .getRepository(CommissionPolicy)
        .findOne({ where: { scope: input.scope, scopeRefId: input.scopeRefId, effectiveTo: IsNull() } });
      const now = new Date();
      if (existingActive) {
        existingActive.effectiveTo = now;
        existingActive.status = 'superseded';
        await manager.getRepository(CommissionPolicy).save(existingActive);
      }

      const saved = await manager.getRepository(CommissionPolicy).save(
        manager.getRepository(CommissionPolicy).create({
          scope: input.scope,
          scopeRefId: input.scopeRefId,
          basis: input.basis,
          rateModel: input.rateModel,
          flatRate: input.flatRate ?? null,
          effectiveFrom: now,
          effectiveTo: null,
          status: 'active',
          createdByUserId: actorUserId,
        }),
      );
      for (const tier of input.tiers ?? []) {
        await manager.getRepository(CommissionTier).save(
          manager.getRepository(CommissionTier).create({ policyId: saved.id, tierOrder: tier.tierOrder, fromPercent: tier.fromPercent, toPercent: tier.toPercent, rate: tier.rate }),
        );
      }

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'commission.policy.created',
          resource: 'commission_policy',
          resourceId: saved.id,
          result: 'success',
          correlationId: null,
          after: { scope: input.scope, scopeRefId: input.scopeRefId, basis: input.basis, rateModel: input.rateModel },
        },
        manager,
      );
      return saved;
    });
  }

  async listPolicies(manager?: EntityManager): Promise<CommissionPolicy[]> {
    return this.repos(manager).policies.find({ order: { createdAt: 'DESC' } });
  }

  async listTiers(policyId: string, manager?: EntityManager): Promise<CommissionTier[]> {
    return this.repos(manager).tiers.find({ where: { policyId }, order: { tierOrder: 'ASC' } });
  }

  // ---------------------------------------------------------------------------
  // Resolution Engine — ADR-068 §A/§9. Never an inline if/else chain.
  // ---------------------------------------------------------------------------

  /** ADR-068 §G — CustomerAssignment.salesRepUserId (User) reverse-resolved to the authoritative Employee. Raw SQL read of CRM's own table, the same "read another domain's table directly, no entity import" pattern Payroll already uses for accounting_financial_events. */
  private async resolveSalesRepEmployeeId(customerId: string, manager?: EntityManager): Promise<string | null> {
    const [assignment]: Array<{ salesRepUserId: string }> = await this.em(manager).query(
      `SELECT "salesRepUserId" FROM customer_assignments WHERE "customerId" = $1 AND status = 'active' ORDER BY "startDate" DESC LIMIT 1`,
      [customerId],
    );
    if (!assignment) return null;
    const employee = await this.hr.getEmployeeByUserId(assignment.salesRepUserId, manager);
    return employee?.id ?? null;
  }

  /** ADR-068 §A's ratified precedence: Customer -> Customer Group (architecturally present, functionally inert per ADR-071 §3/§21) -> Sales Rep. */
  private async resolvePolicy(customerId: string, salesRepEmployeeId: string | null, date: Date, manager?: EntityManager): Promise<CommissionPolicy | null> {
    const dateIso = date.toISOString();

    const byCustomer = await this.repos(manager).policies
      .createQueryBuilder('p')
      .where('p.scope = :scope', { scope: 'customer' })
      .andWhere('p."scopeRefId" = :customerId', { customerId })
      .andWhere('p."effectiveFrom" <= :date', { date: dateIso })
      .andWhere('(p."effectiveTo" IS NULL OR p."effectiveTo" > :date)', { date: dateIso })
      .getOne();
    if (byCustomer) return byCustomer;

    // Customer Group tier: architecturally wired, functionally inert — CRM has no structured
    // Customer Group concept (customer.entity.ts's own documented free-text `classification`
    // field, ADR-071 §3/§21). Nothing to resolve against yet; not invented here.

    if (salesRepEmployeeId) {
      const byRep = await this.repos(manager).policies
        .createQueryBuilder('p')
        .where('p.scope = :scope', { scope: 'sales_rep' })
        .andWhere('p."scopeRefId" = :employeeId', { employeeId: salesRepEmployeeId })
        .andWhere('p."effectiveFrom" <= :date', { date: dateIso })
        .andWhere('(p."effectiveTo" IS NULL OR p."effectiveTo" > :date)', { date: dateIso })
        .getOne();
      if (byRep) return byRep;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Calculation — ADR-068 §3/§4/§C/§7. Marginal tier application; every
  // result is an immutable snapshot with a deterministic dedup key
  // (ADR-071 §12) distinguishing Invoice/Collection/Correction/Recalculation.
  // ---------------------------------------------------------------------------

  private computeMarginalTierAmount(achievementPercent: number, eligibleAmount: number, tiers: CommissionTier[], _manager?: EntityManager): { amount: number; appliedTiers: Array<{ tierOrder: number; rate: string; bandAmount: number }> } {
    let amount = 0;
    const appliedTiers: Array<{ tierOrder: number; rate: string; bandAmount: number }> = [];
    const sorted = [...tiers].sort((a, b) => a.tierOrder - b.tierOrder);
    for (const tier of sorted) {
      const from = Number(tier.fromPercent);
      const to = tier.toPercent !== null ? Number(tier.toPercent) : Infinity;
      if (achievementPercent <= from) continue;
      const bandTop = Math.min(achievementPercent, to);
      const bandPercent = Math.max(0, bandTop - from);
      if (bandPercent <= 0) continue;
      const bandAmount = eligibleAmount * (bandPercent / 100) * Number(tier.rate);
      amount += bandAmount;
      appliedTiers.push({ tierOrder: tier.tierOrder, rate: tier.rate, bandAmount });
    }
    return { amount, appliedTiers };
  }

  private async calculateFromEvent(params: {
    triggerKind: 'invoice' | 'collection';
    sourceEntityId: string;
    customerId: string;
    basisAmountByType: Partial<Record<CommissionBasis, number>>;
    eventDate: Date;
  }, manager?: EntityManager): Promise<CommissionResult | null> {
    const triggerEventKey = `${params.triggerKind}:${params.sourceEntityId}`;
    const existing = await this.repos(manager).results.findOne({ where: { triggerEventKey } });
    if (existing) return existing; // idempotent — a redelivery is a safe no-op, never a duplicate

    const salesRepEmployeeId = await this.resolveSalesRepEmployeeId(params.customerId, manager);
    if (!salesRepEmployeeId) {
      // ADR-071 §14 — no CommissionResult is created; surfaced for admin remediation
      // (link the User to an Employee), never a silently zeroed/wrong result.
      return null;
    }

    const policy = await this.resolvePolicy(params.customerId, salesRepEmployeeId, params.eventDate, manager);
    if (!policy) return null; // no policy resolves — surfaced, not silently skipped or zeroed (ADR-071 §9 step 4)

    const eligibleAmount = params.basisAmountByType[policy.basis];
    if (eligibleAmount === undefined) return null; // this event doesn't carry the basis this policy needs

    let rate: string;
    let applicableTier: Record<string, unknown> | null = null;
    let targetPeriodId: string | null = null;
    let targetSnapshot: Record<string, unknown> | null = null;
    let calculatedAmount: number;

    if (policy.rateModel === 'flat') {
      rate = policy.flatRate ?? '0';
      calculatedAmount = eligibleAmount * Number(rate);
    } else {
      const target = await this.targets.getApprovedTargetForDate(salesRepEmployeeId, params.eventDate.toISOString().slice(0, 10), manager);
      if (!target) return null; // target-tiered policy with no Target available — surfaced, not defaulted (ADR-071 §14)
      const tierRows = await this.repos(manager).tiers.find({ where: { policyId: policy.id } });
      const achievementPercent = (eligibleAmount / Number(target.targetValue)) * 100;
      const { amount, appliedTiers } = this.computeMarginalTierAmount(achievementPercent, eligibleAmount, tierRows, manager);
      calculatedAmount = amount;
      rate = appliedTiers.length > 0 ? appliedTiers[appliedTiers.length - 1].rate : '0';
      applicableTier = { achievementPercent, appliedTiers };
      targetPeriodId = target.id;
      targetSnapshot = { periodStart: target.periodStart, periodEnd: target.periodEnd, targetValue: target.targetValue };
    }

    const saved = await this.repos(manager).results.save(
      this.repos(manager).results.create({
        employeeId: salesRepEmployeeId,
        customerId: params.customerId,
        customerGroupId: null,
        sourceTransactionRefs: { [params.triggerKind]: params.sourceEntityId },
        resolvedPolicyId: policy.id,
        policyScope: policy.scope,
        calculationBasis: policy.basis,
        targetPeriodId,
        targetSnapshot,
        applicableTier,
        rate,
        calculationInputs: { eligibleAmount, basis: policy.basis },
        calculatedAmount: calculatedAmount.toFixed(2),
        calculationTimestamp: new Date(),
        batchId: null,
        triggerEventKey,
      }),
    );
    await this.audit.record({
      actorUserId: SYSTEM_ACTOR_ID,
      organizationId: null,
      action: 'commission.result.calculated',
      resource: 'commission_result',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { employeeId: salesRepEmployeeId, customerId: params.customerId, calculatedAmount: saved.calculatedAmount },
    }, manager);
    return saved;
  }

  private async onInvoicePosted(payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    const invoiceId = String(payload.invoiceId ?? payload.sourceEntityId ?? '');
    const customerId = String(payload.customerId ?? '');
    if (!invoiceId || !customerId) return;
    const netAmount = Number(payload.netAmount ?? 0);
    const grossAmount = Number(payload.grossAmount ?? netAmount);
    await this.calculateFromEvent({
      triggerKind: 'invoice',
      sourceEntityId: invoiceId,
      customerId,
      basisAmountByType: { gross_sales: grossAmount, net_sales: netAmount },
      eventDate: new Date(),
    }, manager);
  }

  private async onCollectionRemitted(payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    const collectionId = String(payload.collectionId ?? '');
    const shipmentId = String(payload.shipmentId ?? '');
    const amount = Number(payload.amount ?? 0);
    if (!collectionId || !shipmentId) return;

    // Collected Amount basis needs the customer, which this event does not carry directly —
    // resolved via the existing Shipment -> Sales Order -> Customer relational path (a read-only
    // join, not a new mechanism), the same "read another domain's table directly" pattern already
    // used for the Sales Rep resolution above.
    const [row]: Array<{ customerId: string }> = await this.em(manager).query(
      `SELECT so."customerId" FROM shipments s JOIN sales_orders so ON so.id = s."salesOrderId" WHERE s.id = $1`,
      [shipmentId],
    );
    if (!row) return;

    await this.calculateFromEvent({
      triggerKind: 'collection',
      sourceEntityId: collectionId,
      customerId: row.customerId,
      basisAmountByType: { collected_amount: amount },
      eventDate: new Date(),
    }, manager);
  }

  // ---------------------------------------------------------------------------
  // Approval Batch — mirrors Attendance's own proven shape (ADR-069 §1).
  // ---------------------------------------------------------------------------

  async submitApprovalBatch(periodStart: string, periodEnd: string, actorUserId: string, manager?: EntityManager): Promise<CommissionApprovalBatch> {
    if (periodStart > periodEnd) throw new ConflictException('periodStart must be on or before periodEnd.');
    const { start, end } = this.utcDayRange(periodStart, periodEnd);
    const inRange = await this.repos(manager).results
      .createQueryBuilder('r')
      .where('r."calculationTimestamp" >= :start', { start })
      .andWhere('r."calculationTimestamp" <= :end', { end })
      .andWhere('r."batchId" IS NULL')
      .getMany();
    if (inRange.length === 0) throw new ConflictException('No un-batched commission results exist in this period.');

    const batch = await this.repos(manager).batches.save(this.repos(manager).batches.create({ periodStart, periodEnd, status: 'draft', createdByUserId: actorUserId }));
    await this.processEngine.start(COMMISSION_BATCH_PROCESS, BATCH_ENTITY_TYPE, batch.id, manager);
    await this.repos(manager).results.update(
      inRange.map((r) => r.id),
      { batchId: batch.id },
    );

    let approvalRequest: { id: string };
    try {
      approvalRequest = await this.approvals.submit({
        requestTypeCode: APPROVAL_TYPE,
        resourceType: BATCH_ENTITY_TYPE,
        resourceId: batch.id,
        requestedAction: 'approve',
        payload: { periodStart, periodEnd, resultCount: inRange.length },
        makerUserId: actorUserId,
      }, manager);
    } catch (err) {
      // Same recovery shape commit d76e22e already proved for Attendance's own approval batches.
      await this.repos(manager).results.update(
        inRange.map((r) => r.id),
        { batchId: null as unknown as string },
      );
      await this.repos(manager).batches.delete(batch.id);
      throw err;
    }

    await this.processEngine.transition(COMMISSION_BATCH_PROCESS, BATCH_ENTITY_TYPE, batch.id, 'submit', actorUserId, manager);
    batch.approvalRequestId = approvalRequest.id;
    batch.status = 'submitted';
    await this.repos(manager).batches.save(batch);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'commission.batch.submitted',
      resource: 'commission_approval_batch',
      resourceId: batch.id,
      result: 'success',
      correlationId: approvalRequest.id,
    }, manager);
    return batch;
  }

  async listApprovalBatches(manager?: EntityManager): Promise<CommissionApprovalBatch[]> {
    return this.repos(manager).batches.find({ order: { createdAt: 'DESC' } });
  }

  async listResults(employeeId?: string, manager?: EntityManager): Promise<CommissionResult[]> {
    return this.repos(manager).results.find({ where: employeeId ? { employeeId } : {}, order: { calculationTimestamp: 'DESC' } });
  }

  /** ADR-071 §9 — Payroll's own read contract into Commission. Returns only APPROVED results, never pending/rejected (ADR-072 §19 item 8). */
  async listApprovedCommissionResults(employeeId: string, periodStart: string, periodEnd: string, manager?: EntityManager): Promise<CommissionResult[]> {
    const { start, end } = this.utcDayRange(periodStart, periodEnd);
    return this.repos(manager).results
      .createQueryBuilder('r')
      .innerJoin(CommissionApprovalBatch, 'b', 'b.id = r."batchId"')
      .where('r."employeeId" = :employeeId', { employeeId })
      .andWhere("b.status = 'approved'")
      .andWhere('r."calculationTimestamp" >= :start', { start })
      .andWhere('r."calculationTimestamp" <= :end', { end })
      .getMany();
  }

  /**
   * Independent re-verification finding (2026-09-21): comparing a
   * `timestamptz` column against a naive `'YYYY-MM-DD'`/`'YYYY-MM-DD
   * 23:59:59'` string lets Postgres cast it using the SESSION's
   * configured timezone (e.g. `Africa/Cairo`, UTC+3), not UTC — silently
   * shifting the intended "today, UTC" window and wrongly excluding a
   * `CommissionResult` calculated in the last few hours of a UTC calendar
   * day. Same defect class as `54d8818`'s Attendance fix (a
   * timezone-aware instant compared against a timezone-naive boundary),
   * fixed here at its own call sites: build explicit UTC instants
   * (`Date` objects with an unambiguous `Z` offset) once, in application
   * code, so the comparison is timezone-safe regardless of the DB
   * session's own configured timezone.
   */
  private utcDayRange(periodStart: string, periodEnd: string): { start: Date; end: Date } {
    return {
      start: new Date(`${periodStart}T00:00:00.000Z`),
      end: new Date(`${periodEnd}T23:59:59.999Z`),
    };
  }

  /** Pure pass-through to the generic engine — same shape as every other FA-01 consumer's own `decide`. */
  async decide(requestId: string, approverUserId: string, decision: 'approved' | 'rejected', note?: string | null, manager?: EntityManager): Promise<unknown> {
    return this.approvals.decide(requestId, approverUserId, decision, note ?? null, manager);
  }

  private async onApprovalApproved(payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (requestTypeCode !== APPROVAL_TYPE) return;
    const resourceId = String(payload.resourceId ?? '');
    const batch = await this.repos(manager).batches.findOne({ where: { id: resourceId } });
    if (!batch || batch.status === 'approved') return;

    // Atomic, matching PayrollService's/TargetService's own proven `onApprovalApproved` shape —
    // a DB-level failure on the batch save must never leave ProcessEngine's own state ahead of it.
    await this.em(manager).transaction(async (manager) => {
      await this.processEngine.transition(COMMISSION_BATCH_PROCESS, BATCH_ENTITY_TYPE, batch.id, 'approve', SYSTEM_ACTOR_ID, manager);
      batch.status = 'approved';
      batch.decidedAt = new Date();
      await manager.getRepository(CommissionApprovalBatch).save(batch);
    });
    await this.audit.record({
      actorUserId: SYSTEM_ACTOR_ID,
      organizationId: null,
      action: 'commission.batch.approved',
      resource: 'commission_approval_batch',
      resourceId: batch.id,
      result: 'success',
      correlationId: String(payload.approvalRequestId ?? ''),
    }, manager);
  }

  private async onApprovalRejected(payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (requestTypeCode !== APPROVAL_TYPE) return;
    const resourceId = String(payload.resourceId ?? '');
    const batch = await this.repos(manager).batches.findOne({ where: { id: resourceId } });
    if (!batch || batch.status === 'rejected') return;

    await this.em(manager).transaction(async (manager) => {
      await this.processEngine.transition(COMMISSION_BATCH_PROCESS, BATCH_ENTITY_TYPE, batch.id, 'reject', SYSTEM_ACTOR_ID, manager);
      batch.status = 'rejected';
      batch.decidedAt = new Date();
      await manager.getRepository(CommissionApprovalBatch).save(batch);
      await manager.getRepository(CommissionResult).update({ batchId: batch.id }, { batchId: null as unknown as string });
    });
  }

  // ---------------------------------------------------------------------------
  // Correction — ADR-068 §H. No CommissionResult field is ever updated.
  // ---------------------------------------------------------------------------

  async createAdjustment(input: CreateAdjustmentInput, actorUserId: string, manager?: EntityManager): Promise<CommissionAdjustment> {
    const result = await this.repos(manager).results.findOne({ where: { id: input.originalCommissionResultId } });
    if (!result) throw new NotFoundException(`CommissionResult "${input.originalCommissionResultId}" not found.`);

    const saved = await this.repos(manager).adjustments.save(
      this.repos(manager).adjustments.create({
        originalCommissionResultId: input.originalCommissionResultId,
        kind: input.kind,
        reason: input.reason,
        amountDelta: input.amountDelta,
        createdByUserId: actorUserId,
      }),
    );
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'commission.adjustment.created',
      resource: 'commission_adjustment',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { originalCommissionResultId: input.originalCommissionResultId, kind: input.kind, amountDelta: input.amountDelta },
    }, manager);
    return saved;
  }

  async listAdjustments(originalCommissionResultId?: string, manager?: EntityManager): Promise<CommissionAdjustment[]> {
    return this.repos(manager).adjustments.find({ where: originalCommissionResultId ? { originalCommissionResultId } : {}, order: { createdAt: 'DESC' } });
  }
}
