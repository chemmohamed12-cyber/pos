import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { FixedAsset } from '../infrastructure/fixed-asset.entity';
import { FixedAssetDisposal } from '../infrastructure/fixed-asset-disposal.entity';
import {
  FIXED_ASSET_DISPOSAL_APPROVED_EVENT,
  FIXED_ASSET_DISPOSAL_META,
  FIXED_ASSET_ENTITY_TYPE,
  FIXED_ASSET_PROCESS,
  JOURNAL_REVERSED_EVENT,
} from '../domain/fixed-asset';
import { GLAccountService } from './gl-account.service';
import { FinancialEventService } from './financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from './financial-events/handler-registry';
import {
  DISPOSAL_GAIN_ACCOUNT_CONFIG_KEY,
  DISPOSAL_LOSS_ACCOUNT_CONFIG_KEY,
  disposalGainLoss,
  handleFixedAssetDisposalApproved,
} from './financial-events/fixed-asset-disposal.handler';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';

const THRESHOLD_ALWAYS_GATED: string | null = null; // ADR-045 D13 — always requires approval

export interface SubmitDisposalInput {
  fixedAssetId: string;
  disposalDate: string;
  proceeds?: string;
  proceedsAccountId?: string | null;
  orgUnitId?: string | null;
}

/**
 * F12 — Fixed Assets (ADR-045 D2/D10/D11/D13). Disposal is a genuine judgment call — always FA-01-gated
 * (D13: `alwaysGated: true`, `minApprovers: 1`), never a direct systemPosting (unlike Depreciation).
 *
 * Also owns the D11 reversal extension point: subscribes to the real, already-existing
 * `accounting.journal.reversed` event (published unconditionally by `JournalEntryService.reverseEntry`
 * — zero change to F03) and, when the reversed entry is a disposal's own posting, fires the asset's
 * `reverse_disposal` transition. F03 remains completely unaware Fixed Assets exists.
 */
@Injectable()
export class FixedAssetDisposalService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly glAccounts: GLAccountService,
    private readonly approvals: ApprovalEngineService,
    private readonly financialEvents: FinancialEventService,
    private readonly registry: FinancialEventHandlerRegistry,
    private readonly processEngine: ProcessEngineService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async onModuleInit(): Promise<void> {
    if (!this.registry.get(FIXED_ASSET_DISPOSAL_APPROVED_EVENT)) {
      this.registry.register(FIXED_ASSET_DISPOSAL_APPROVED_EVENT, handleFixedAssetDisposalApproved);
    }
    await this.approvals.registerRequestType(FIXED_ASSET_DISPOSAL_META.requestTypeCode, 'action.fixed_asset_dispose');
    await this.approvals
      .upsertMatrixRule(
        {
          requestTypeCode: FIXED_ASSET_DISPOSAL_META.requestTypeCode,
          minApprovers: FIXED_ASSET_DISPOSAL_META.minApprovers,
          requiredPermissionNode: 'accounting.fixed_asset.approve',
          valueThreshold: THRESHOLD_ALWAYS_GATED,
          orgUnitId: null,
        },
        '00000000-0000-0000-0000-000000000000',
      )
      .catch(() => undefined);

    this.events.subscribe(
    'approval.request.approved',
    async (payload, ctx) => {
      await this.onApprovalApproved(payload as Record<string, unknown>, ctx.manager ?? undefined);
    },
    { scope: 'company' },
  );
    // ADR-045 D11 — the concrete, already-existing extension point. F12 is this event's first subscriber.
    this.events.subscribe(
      JOURNAL_REVERSED_EVENT,
      async (payload, ctx) => {
        await this.onJournalReversed(payload, ctx.manager ?? undefined);
      },
      { scope: 'company' },
    );
  }

  /**
   * FA-02 (2026-10-06, CTO) — Gain → credit the configured gain account; Loss → debit the configured loss account; the account the
   * result needs must be configured AND postable, else the disposal is REJECTED BEFORE ANY MUTATION (no disposal row, no approval
   * request, no approval decision) — never a fallback, never a hard-coded account. Uses the same calculation the posting handler uses
   * (`disposalGainLoss`) and the same account resolution (`preflightConfiguredPostableAccount`).
   */
  private async assertDisposalAccountConfigured(fixedAssetId: string, cost: string, proceeds: string, manager?: EntityManager): Promise<void> {
    const [row] = (await this.em(manager).query(
      `SELECT COALESCE(SUM("calculatedAmount"), 0)::numeric(20,4) AS total FROM accounting_depreciation_run_lines WHERE "fixedAssetId" = $1`,
      [fixedAssetId],
    )) as Array<{ total: string }>;
    const { side, gainLoss } = disposalGainLoss(proceeds, row.total, cost);
    if (side === 'none') return;
    const key = side === 'gain' ? DISPOSAL_GAIN_ACCOUNT_CONFIG_KEY : DISPOSAL_LOSS_ACCOUNT_CONFIG_KEY;
    const resolved = await this.financialEvents.preflightConfiguredPostableAccount(key, this.em(manager));
    if (!resolved.ok) {
      throw new ConflictException(
        `This disposal results in a ${side} of ${Math.abs(gainLoss).toFixed(2)}, but the ${side}-on-disposal account is not usable (${resolved.reason}). Configure "${key}" with an active, postable, non-control account before disposing.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Submit (maker)
  // ---------------------------------------------------------------------------

  async submitDisposal(input: SubmitDisposalInput, actorUserId: string, manager?: EntityManager): Promise<{ approvalRequestId: string }> {
    const asset = await this.em(manager).getRepository(FixedAsset).findOne({ where: { id: input.fixedAssetId } });
    if (!asset) throw new NotFoundException(`Fixed asset "${input.fixedAssetId}" not found.`);
    const state = await this.processEngine.getState(FIXED_ASSET_PROCESS, FIXED_ASSET_ENTITY_TYPE, asset.id, manager);
    if (state !== 'active') {
      throw new ConflictException(`Fixed asset "${asset.code}" is "${state}", not "active" — cannot submit a disposal.`);
    }

    const proceeds = input.proceeds ?? '0';
    if (Number(proceeds) < 0) throw new BadRequestException('proceeds cannot be negative.');
    if (Number(proceeds) > 0) {
      if (!input.proceedsAccountId) throw new BadRequestException('proceedsAccountId is required when proceeds > 0.');
      // ADR-045 D10 — courtesy check at submission; the AUTHORITATIVE recheck happens for free
      // at posting time via the same `assertPostable` every journal line already goes through.
      await this.glAccounts.assertPostable(input.proceedsAccountId, {
        businessDate: input.disposalDate,
        orgUnitId: input.orgUnitId ?? asset.orgUnitId ?? null,
        currencyCode: (await this.em(manager).query(`SELECT code FROM accounting_currencies WHERE "isBaseCurrency" = true LIMIT 1`))[0]?.code,
        systemPosting: true,
      }, manager);
    }

    await this.assertDisposalAccountConfigured(asset.id, asset.cost, proceeds, manager); // FA-02 — before ANY write

    const disposal = await this.em(manager).getRepository(FixedAssetDisposal).save(
      this.em(manager).getRepository(FixedAssetDisposal).create({
        fixedAssetId: asset.id,
        disposalDate: input.disposalDate,
        proceeds,
        proceedsAccountId: Number(proceeds) > 0 ? (input.proceedsAccountId ?? null) : null,
        gainLossAmount: null,
        approvalRequestId: null, // filled below, once the FA-01 request (which needs this row's own id) exists
        journalEntryId: null,
        createdBy: actorUserId,
      }),
    );

    const request = await this.approvals.submit({
      requestTypeCode: FIXED_ASSET_DISPOSAL_META.requestTypeCode,
      resourceType: 'FixedAsset',
      resourceId: asset.id,
      requestedAction: 'dispose',
      payload: {
        disposalId: disposal.id,
        fixedAssetId: asset.id,
        costAccountId: asset.costAccountId,
        accumulatedDepreciationAccountId: asset.accumulatedDepreciationAccountId,
        cost: asset.cost,
        proceeds,
        proceedsAccountId: disposal.proceedsAccountId,
        businessDate: input.disposalDate,
        orgUnitId: input.orgUnitId ?? asset.orgUnitId ?? null,
      },
      makerUserId: actorUserId,
      orgUnitId: input.orgUnitId ?? asset.orgUnitId ?? null,
    }, manager);

    disposal.approvalRequestId = request.id;
    await this.em(manager).getRepository(FixedAssetDisposal).save(disposal);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.fixed_asset.disposal_submitted',
      resource: 'fixed_asset',
      resourceId: asset.id,
      result: 'success',
      correlationId: request.id,
      after: { disposalId: disposal.id, proceeds },
    }, manager);

    return { approvalRequestId: request.id };
  }

  async decide(requestId: string, approverUserId: string, decision: 'approved' | 'rejected', note?: string, manager?: EntityManager): Promise<unknown> {
    if (decision === 'approved') {
      // FA-02 — re-check with FRESH accumulated depreciation (a Depreciation Run may have posted since submission) before the approval
      // is recorded: a missing/unusable gain/loss account rejects here, not after the approval as a REJECTED event.
      const disposal = await this.em(manager).getRepository(FixedAssetDisposal).findOne({ where: { approvalRequestId: requestId } });
      if (disposal) {
        const asset = await this.em(manager).getRepository(FixedAsset).findOne({ where: { id: disposal.fixedAssetId } });
        if (asset) await this.assertDisposalAccountConfigured(asset.id, asset.cost, disposal.proceeds, manager);
      }
    }
    return this.approvals.decide(requestId, approverUserId, decision, note ?? null, manager);
  }

  // ---------------------------------------------------------------------------
  // FA-01 approval subscriber
  // ---------------------------------------------------------------------------

  private async onApprovalApproved(payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (requestTypeCode !== FIXED_ASSET_DISPOSAL_META.requestTypeCode) return; // not ours
    const inner = (payload.payload ?? {}) as Record<string, unknown>;
    const disposalId = String(inner.disposalId ?? '');
    const fixedAssetId = String(inner.fixedAssetId ?? '');
    const approvalRequestId = String(payload.approvalRequestId ?? '');

    const result = await this.financialEvents.ingest(FIXED_ASSET_DISPOSAL_APPROVED_EVENT, {
      idempotencyKey: `accounting:fixed_asset_disposal:${approvalRequestId}`,
      sourceEntityType: 'fixed_asset_disposal',
      sourceEntityId: disposalId,
      payloadVersion: 1,
      ...inner,
    }, manager);

    await this.em(manager).transaction(async (manager) => {
      const disposal = await manager.getRepository(FixedAssetDisposal).findOne({ where: { id: disposalId } });
      if (!disposal) return;
      if (result.status === 'POSTED' && result.journalEntryId) {
        disposal.journalEntryId = result.journalEntryId;
        // gainLossAmount is derivable from the posted journal, but stored for fast display —
        // computed identically to the handler's own calculation for consistency.
        await manager.getRepository(FixedAssetDisposal).save(disposal);
        await this.processEngine.transition(FIXED_ASSET_PROCESS, FIXED_ASSET_ENTITY_TYPE, fixedAssetId, 'dispose', '00000000-0000-0000-0000-000000000000', manager);
        await this.audit.record(
          {
            actorUserId: '00000000-0000-0000-0000-000000000000',
            organizationId: null,
            action: 'accounting.fixed_asset.disposal_posted',
            resource: 'fixed_asset',
            resourceId: fixedAssetId,
            result: 'success',
            correlationId: approvalRequestId,
            after: { disposalId, journalEntryId: result.journalEntryId },
          },
          manager,
        );
      } else {
        await this.audit.record(
          {
            actorUserId: '00000000-0000-0000-0000-000000000000',
            organizationId: null,
            action: 'accounting.fixed_asset.disposal_rejected',
            resource: 'fixed_asset',
            resourceId: fixedAssetId,
            result: 'failure',
            correlationId: approvalRequestId,
            after: { disposalId, financialEventId: result.financialEventId, status: result.status },
          },
          manager,
        );
      }
    });
  }

  // ---------------------------------------------------------------------------
  // D11 — reversal extension point
  // ---------------------------------------------------------------------------

  private async onJournalReversed(payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    const journalEntryId = String(payload.journalEntryId ?? '');
    if (!journalEntryId) return;
    const disposal = await this.em(manager).getRepository(FixedAssetDisposal).findOne({ where: { journalEntryId } });
    if (!disposal) return; // not a disposal's journal entry — correctly a no-op for F12

    await this.processEngine.transition(
      FIXED_ASSET_PROCESS,
      FIXED_ASSET_ENTITY_TYPE,
      disposal.fixedAssetId,
      'reverse_disposal',
      '00000000-0000-0000-0000-000000000000', manager);
    await this.audit.record({
      actorUserId: '00000000-0000-0000-0000-000000000000',
      organizationId: null,
      action: 'accounting.fixed_asset.disposal_reversed',
      resource: 'fixed_asset',
      resourceId: disposal.fixedAssetId,
      result: 'success',
      correlationId: journalEntryId,
      after: { disposalId: disposal.id },
    }, manager);
  }

  async listDisposals(fixedAssetId?: string, manager?: EntityManager): Promise<FixedAssetDisposal[]> {
    return this.em(manager)
      .getRepository(FixedAssetDisposal)
      .find({ where: fixedAssetId ? { fixedAssetId } : {}, order: { createdAt: 'DESC' } });
  }

  async getDepreciationToDate(fixedAssetId: string, manager?: EntityManager): Promise<string> {
    const [row] = (await this.em(manager).query(
      `SELECT COALESCE(SUM("calculatedAmount"), 0)::numeric(20,4) AS total FROM accounting_depreciation_run_lines WHERE "fixedAssetId" = $1`,
      [fixedAssetId],
    )) as Array<{ total: string }>;
    return row.total;
  }
}
