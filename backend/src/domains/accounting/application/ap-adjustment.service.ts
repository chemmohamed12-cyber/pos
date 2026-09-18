import { BadRequestException, ConflictException, Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import {
  AP_ADJUSTMENT_META,
  AP_ADJUSTMENT_POSTING,
  AP_APPROVAL_REQUEST_TYPES,
  AP_APPROVER_PERMISSION_NODE,
  ApAdjustmentKind,
  isApAdjustmentKind,
} from '../domain/ap';
import { FinancialEventService } from './financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from './financial-events/handler-registry';
import { handleApAdjustmentApproved } from './financial-events/ap-adjustment.handler';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import {
  AP_ADJUSTMENT_APPROVED_EVENT,
  SUPPLIER_LEDGER_CONTRACT,
  SupplierLedgerContract,
} from '../../../foundation/module-registry/contracts/ap-events.contract';
import { isPositiveAmount } from '../domain/money';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

export interface SubmitApAdjustmentInput {
  /** free-text supplier reference — there is no supplier master in F05 (ADR-037 D1); a future OP-AP phase makes this a real id. */
  supplierRef: string;
  kind: ApAdjustmentKind;
  amount: string;
  reason: string;
  /** for `adjustment` — the contra GL account code; `direction` sets which side the AP-position moves. */
  contraAccountCode?: string | null;
  direction?: 'debit' | 'credit';
  /** explicit target when the chart has more than one `ap` control account (the handler never guesses). */
  apAccountCode?: string | null;
  businessDate?: string;
  orgUnitId?: string | null;
}

/**
 * F05 — Accounts Payable (ADR-037 D3/D5, Blueprint §5). Maker-checker for
 * AP write-off / credit-note / debit-note / adjustment / opening-balance,
 * **via FA-01** (no AP-specific approval engine).
 *
 * **CTO amendment:** every kind is `alwaysGated` — there is no
 * straight-through path.
 *
 * On approval: an internal `FinancialEvent`
 * (`accounting.ap.adjustment.approved`) is ingested → F05's handler →
 * F03's posting gate → the `ap` control account. **No operational
 * subledger step in V1** (ADR-037 D1/D3) — the `ap` control account *is*
 * the AP position. When the OP-AP phase binds `SUPPLIER_LEDGER_CONTRACT`,
 * the `@Optional()` hook below writes the subledger movement first.
 */
@Injectable()
export class ApAdjustmentService implements OnModuleInit {
  constructor(
    private readonly approvals: ApprovalEngineService,
    private readonly financialEvents: FinancialEventService,
    private readonly registry: FinancialEventHandlerRegistry,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    @Optional() @Inject(SUPPLIER_LEDGER_CONTRACT) private readonly supplierLedger?: SupplierLedgerContract,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.registry.get(AP_ADJUSTMENT_APPROVED_EVENT)) {
      this.registry.register(AP_ADJUSTMENT_APPROVED_EVENT, handleApAdjustmentApproved);
    }
    for (const [kind, meta] of Object.entries(AP_ADJUSTMENT_META)) {
      await this.approvals.registerRequestType(meta.requestTypeCode, `action.ap_${kind}`);
      await this.approvals
        .upsertMatrixRule(
          {
            requestTypeCode: meta.requestTypeCode,
            minApprovers: meta.minApprovers,
            requiredPermissionNode: AP_APPROVER_PERMISSION_NODE,
            valueThreshold: null, // CTO decision — always gated
            orgUnitId: null,
          },
          SYSTEM_ACTOR,
        )
        .catch(() => undefined); // idempotent-ish; a concurrent init is harmless
    }
    this.events.subscribe('approval.request.approved', async (payload) => {
      await this.onApprovalApproved(payload);
    });
  }

  // ---------------------------------------------------------------------------
  // Submit (maker) — always gated
  // ---------------------------------------------------------------------------

  async submitAdjustment(input: SubmitApAdjustmentInput, actorUserId: string): Promise<{ mode: 'approval'; approvalRequestId: string }> {
    if (!isApAdjustmentKind(input.kind)) throw new BadRequestException(`Unknown AP adjustment kind "${input.kind}".`);
    if (!isPositiveAmount(input.amount)) throw new BadRequestException('Amount must be a positive decimal.');
    if (!input.reason?.trim()) throw new BadRequestException('A reason is required.');
    if (!input.supplierRef?.trim()) throw new BadRequestException('A supplierRef is required.');
    if (input.kind === 'adjustment' && !input.contraAccountCode?.trim()) {
      throw new BadRequestException('An `adjustment` requires a contraAccountCode.');
    }

    const meta = AP_ADJUSTMENT_META[input.kind];
    const payload = {
      kind: input.kind,
      supplierRef: input.supplierRef.trim(),
      amount: input.amount,
      reason: input.reason.trim(),
      contraAccountCode: input.contraAccountCode ?? null,
      direction: input.direction ?? AP_ADJUSTMENT_POSTING[input.kind].positionDirection,
      apAccountCode: input.apAccountCode ?? null,
      businessDate: input.businessDate ?? new Date().toISOString().slice(0, 10),
      orgUnitId: input.orgUnitId ?? null,
    };

    const request = await this.approvals.submit({
      requestTypeCode: meta.requestTypeCode,
      resourceType: 'SupplierAP',
      resourceId: input.supplierRef.trim().slice(0, 64),
      requestedAction: input.kind,
      payload,
      makerUserId: actorUserId,
      orgUnitId: input.orgUnitId ?? null,
    });
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.ap.adjustment_submitted',
      resource: 'approval_request',
      resourceId: request.id,
      result: 'success',
      correlationId: input.supplierRef.trim().slice(0, 64),
      after: { kind: input.kind, amount: input.amount, requestTypeCode: meta.requestTypeCode },
    });
    return { mode: 'approval', approvalRequestId: request.id };
  }

  // ---------------------------------------------------------------------------
  // FA-01 approval subscriber
  // ---------------------------------------------------------------------------

  private async onApprovalApproved(payload: Record<string, unknown>): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (!Object.values(AP_APPROVAL_REQUEST_TYPES).includes(requestTypeCode as never)) return; // not ours
    const inner = (payload.payload ?? {}) as Record<string, unknown>;
    await this.performApprovedAdjustment(inner, SYSTEM_ACTOR, String(payload.approvalRequestId ?? ''));
  }

  private async performApprovedAdjustment(
    p: Record<string, unknown>,
    actorUserId: string,
    approvalRequestId = '',
  ): Promise<string> {
    const kind = String(p.kind) as ApAdjustmentKind;
    const supplierRef = String(p.supplierRef ?? '');
    const amount = String(p.amount);
    const posting = AP_ADJUSTMENT_POSTING[kind];
    const direction = (String(p.direction) === 'credit' ? 'credit' : String(p.direction) === 'debit' ? 'debit' : posting.positionDirection) as
      | 'debit'
      | 'credit';
    const idBase = approvalRequestId || `${supplierRef}:${kind}:${amount}:${p.businessDate}`;

    // (future OP-AP) — write the operational supplier-ledger movement first, if a source is bound.
    if (this.supplierLedger) {
      await this.supplierLedger.postEntry({
        supplierId: supplierRef,
        entryType: posting.entryType,
        direction,
        amount,
        reason: `AP ${kind}: ${String(p.reason ?? '')}`.slice(0, 250),
        createdByUserId: actorUserId,
      });
    }

    // GL via an internal FinancialEvent → F05 handler → F03 posting gate
    const result = await this.financialEvents.ingest(AP_ADJUSTMENT_APPROVED_EVENT, {
      idempotencyKey: `accounting:ap_adjustment:${idBase}`,
      businessDate: p.businessDate ?? new Date().toISOString().slice(0, 10),
      orgUnitId: p.orgUnitId ?? null,
      currency: 'EGP',
      sourceEntityType: 'ledger_entry',
      sourceEntityId: supplierRef.slice(0, 64),
      payloadVersion: 1,
      kind,
      supplierRef,
      amount,
      reason: p.reason ?? '',
      contraAccountCode: p.contraAccountCode ?? null,
      direction,
      apAccountCode: p.apAccountCode ?? null,
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.ap.adjustment_posted',
      resource: 'supplier_ap',
      resourceId: supplierRef.slice(0, 64),
      result: result.status === 'POSTED' ? 'success' : 'failure',
      correlationId: approvalRequestId || null,
      after: { kind, amount, financialEventId: result.financialEventId, status: result.status },
    });

    if (result.status === 'REJECTED') {
      throw new ConflictException(`AP ${kind} GL posting was rejected — see financial event ${result.financialEventId}.`);
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
