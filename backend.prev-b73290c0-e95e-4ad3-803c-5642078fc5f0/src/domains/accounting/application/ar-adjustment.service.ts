import { BadRequestException, ConflictException, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  AR_ADJUSTMENT_META,
  AR_ADJUSTMENT_POSTING,
  AR_APPROVAL_REQUEST_TYPES,
  AR_APPROVER_PERMISSION_NODE,
  ArAdjustmentKind,
  isArAdjustmentKind,
} from '../domain/ar';
import { FinancialEventService } from './financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from './financial-events/handler-registry';
import { handleArAdjustmentApproved } from './financial-events/ar-adjustment.handler';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import {
  FINANCE_CUSTOMER_LEDGER_CONTRACT,
  FinanceCustomerLedgerContract,
} from '../../../foundation/module-registry/contracts/finance.contract';
import { isPositiveAmount } from '../domain/money';

const AR_INTERNAL_EVENT_TYPE = 'accounting.ar.adjustment.approved';
/** Stated defaults (F01/F02/F03 disclosure pattern — no domain consumes the Configuration Engine's live values yet). `null` = approval always required (CTO decision D-06). */
const THRESHOLD_DEFAULT: string | null = null;

export interface SubmitArAdjustmentInput {
  customerId: string;
  kind: ArAdjustmentKind;
  amount: string;
  reason: string;
  /** for `adjustment` — the contra GL account code; also the direction of the AR movement */
  contraAccountCode?: string | null;
  direction?: 'debit' | 'credit';
  businessDate?: string;
  orgUnitId?: string | null;
}

/**
 * F04 — Accounts Receivable (ADR-036 D5, Blueprint §5). Maker-checker for
 * AR write-off / credit-note / debit-note / adjustment / opening-balance,
 * **via FA-01** (no AR-specific approval engine). On approval:
 *   1. the subledger movement is written via `FINANCE_CUSTOMER_LEDGER_CONTRACT.postEntry`
 *      (the sanctioned cross-domain route, ADR-027 — never a raw table write)
 *   2. an internal `FinancialEvent` (`accounting.ar.adjustment.approved`) is
 *      ingested → F04's handler → F03's posting gate → the `ar` control account
 * Routine invoice posting / payment recording are NOT gated (ADR-036 D5).
 */
@Injectable()
export class ArAdjustmentService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly approvals: ApprovalEngineService,
    private readonly financialEvents: FinancialEventService,
    private readonly registry: FinancialEventHandlerRegistry,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    @Inject(FINANCE_CUSTOMER_LEDGER_CONTRACT) private readonly customerLedger: FinanceCustomerLedgerContract,
  ) {}

  async onModuleInit(): Promise<void> {
    // register the internal AR-adjustment GL handler
    if (!this.registry.get(AR_INTERNAL_EVENT_TYPE)) {
      this.registry.register(AR_INTERNAL_EVENT_TYPE, handleArAdjustmentApproved);
    }
    // register the FA-01 request types + a default matrix rule per type (CTO decision D-07)
    for (const [kind, meta] of Object.entries(AR_ADJUSTMENT_META)) {
      await this.approvals.registerRequestType(meta.requestTypeCode, `action.ar_${kind}`);
      await this.approvals
        .upsertMatrixRule(
          {
            requestTypeCode: meta.requestTypeCode,
            minApprovers: meta.minApprovers,
            requiredPermissionNode: AR_APPROVER_PERMISSION_NODE,
            valueThreshold: THRESHOLD_DEFAULT,
            orgUnitId: null,
          },
          '00000000-0000-0000-0000-000000000000',
        )
        .catch(() => undefined); // idempotent-ish; a concurrent init is harmless
    }
    // subscribe once to FA-01's approval event — perform the approved AR action
    this.events.subscribe('approval.request.approved', async (payload) => {
      await this.onApprovalApproved(payload);
    });
  }

  // ---------------------------------------------------------------------------
  // Submit (maker)
  // ---------------------------------------------------------------------------

  async submitAdjustment(input: SubmitArAdjustmentInput, actorUserId: string): Promise<{ mode: 'approval' | 'straight_through'; approvalRequestId?: string; financialEventId?: string }> {
    if (!isArAdjustmentKind(input.kind)) throw new BadRequestException(`Unknown AR adjustment kind "${input.kind}".`);
    if (!isPositiveAmount(input.amount)) throw new BadRequestException('Amount must be a positive decimal.');
    if (!input.reason?.trim()) throw new BadRequestException('A reason is required.');
    if (input.kind === 'adjustment' && !input.contraAccountCode?.trim()) {
      throw new BadRequestException('An `adjustment` requires a contraAccountCode.');
    }

    const meta = AR_ADJUSTMENT_META[input.kind];
    const threshold = THRESHOLD_DEFAULT; // per-kind config keys (stated default null = always gated)
    const gated = meta.alwaysGated || threshold === null || Number(input.amount) > Number(threshold);

    const payload = {
      kind: input.kind,
      customerId: input.customerId,
      amount: input.amount,
      reason: input.reason.trim(),
      contraAccountCode: input.contraAccountCode ?? null,
      direction: input.direction ?? AR_ADJUSTMENT_POSTING[input.kind].subledgerDirection,
      businessDate: input.businessDate ?? new Date().toISOString().slice(0, 10),
      orgUnitId: input.orgUnitId ?? null,
    };

    if (!gated) {
      const financialEventId = await this.performApprovedAdjustment(payload, actorUserId);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'accounting.ar.adjustment_straight_through',
        resource: 'customer',
        resourceId: input.customerId,
        result: 'success',
        correlationId: null,
        after: { kind: input.kind, amount: input.amount },
      });
      return { mode: 'straight_through', financialEventId };
    }

    const request = await this.approvals.submit({
      requestTypeCode: meta.requestTypeCode,
      resourceType: 'CustomerAR',
      resourceId: input.customerId,
      requestedAction: input.kind,
      payload,
      makerUserId: actorUserId,
      orgUnitId: input.orgUnitId ?? null,
    });
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.ar.adjustment_submitted',
      resource: 'approval_request',
      resourceId: request.id,
      result: 'success',
      correlationId: input.customerId,
      after: { kind: input.kind, amount: input.amount, requestTypeCode: meta.requestTypeCode },
    });
    return { mode: 'approval', approvalRequestId: request.id };
  }

  // ---------------------------------------------------------------------------
  // FA-01 approval subscriber
  // ---------------------------------------------------------------------------

  private async onApprovalApproved(payload: Record<string, unknown>): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (!Object.values(AR_APPROVAL_REQUEST_TYPES).includes(requestTypeCode as never)) return; // not ours
    const inner = (payload.payload ?? {}) as Record<string, unknown>;
    await this.performApprovedAdjustment(inner, '00000000-0000-0000-0000-000000000000', String(payload.approvalRequestId ?? ''));
  }

  private async performApprovedAdjustment(
    p: Record<string, unknown>,
    actorUserId: string,
    approvalRequestId = '',
  ): Promise<string> {
    const kind = String(p.kind) as ArAdjustmentKind;
    const customerId = String(p.customerId);
    const amount = String(p.amount);
    const posting = AR_ADJUSTMENT_POSTING[kind];
    const direction = (String(p.direction) === 'debit' ? 'debit' : posting.subledgerDirection) as 'debit' | 'credit';
    const idBase = approvalRequestId || `${customerId}:${kind}:${amount}:${p.businessDate}`;

    // 1. subledger movement via the sanctioned contract (ADR-027 / ADR-036 D11)
    await this.customerLedger.postEntry({
      customerId,
      entryType: posting.subledgerEntryType,
      direction,
      amount,
      reason: `AR ${kind}: ${String(p.reason ?? '')}`.slice(0, 250),
      createdByUserId: actorUserId,
    });

    // 2. GL via an internal FinancialEvent → F04 handler → F03 posting gate
    const result = await this.financialEvents.ingest(AR_INTERNAL_EVENT_TYPE, {
      idempotencyKey: `accounting:ar_adjustment:${idBase}`,
      businessDate: p.businessDate ?? new Date().toISOString().slice(0, 10),
      orgUnitId: p.orgUnitId ?? null,
      currency: 'EGP',
      sourceEntityType: 'ledger_entry',
      sourceEntityId: customerId,
      payloadVersion: 1,
      kind,
      customerId,
      amount,
      reason: p.reason ?? '',
      contraAccountCode: p.contraAccountCode ?? null,
      direction,
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.ar.adjustment_posted',
      resource: 'customer',
      resourceId: customerId,
      result: result.status === 'POSTED' ? 'success' : 'failure',
      correlationId: approvalRequestId || null,
      after: { kind, amount, financialEventId: result.financialEventId, status: result.status },
    });

    if (result.status === 'REJECTED') {
      throw new ConflictException(`AR ${kind} GL posting was rejected — see financial event ${result.financialEventId}.`);
    }
    return result.financialEventId;
  }

  // ---------------------------------------------------------------------------
  // Checker
  // ---------------------------------------------------------------------------

  async decide(requestId: string, approverUserId: string, decision: 'approved' | 'rejected', note?: string): Promise<unknown> {
    return this.approvals.decide(requestId, approverUserId, decision, note ?? null);
  }
}
