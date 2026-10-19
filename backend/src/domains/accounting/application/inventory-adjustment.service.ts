import { BadRequestException, ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Inject, Optional } from '@nestjs/common';
import {
  INVENTORY_ADJUSTMENT_META,
  INVENTORY_APPROVAL_REQUEST_TYPES,
  INVENTORY_APPROVER_PERMISSION_NODE,
  InventoryAdjustmentKind,
  isInventoryAdjustmentKind,
} from '../domain/inventory';
import { GLAccount } from '../infrastructure/gl-account.entity';
import { FinancialEventService } from './financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from './financial-events/handler-registry';
import { handleInventoryAdjustmentApproved } from './financial-events/inventory-adjustment.handler';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { INVENTORY_ADJUSTMENT_APPROVED_EVENT, INVENTORY_VALUATION_CONTRACT, InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { isPositiveAmount } from '../domain/money';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

export interface SubmitInventoryAdjustmentInput {
  productId?: string | null;
  warehouseId?: string | null;
  kind: InventoryAdjustmentKind;
  amount: string;
  reason: string;
  /** 'debit' | 'credit' — the `inventory` account's movement. Default 'credit' (a value decrease). */
  direction?: 'debit' | 'credit';
  /** the maker-supplied counter/contra account — required, fail-closed validated at submit time. */
  counterAccountCode: string;
  businessDate?: string;
  orgUnitId?: string | null;
}

/**
 * F07 — Inventory Accounting (ADR-040 D7/D12, CTO Mandatory Condition 1).
 * Maker-checker for inventory *adjustments with a financial impact*, via
 * FA-01 (no inventory-specific approval engine). Both kinds are ALWAYS
 * gated — there is no straight-through path (mirrors F05's every-kind-
 * alwaysGated precedent), because an inventory financial adjustment is
 * exactly the kind of event the CTO directive singles out for maker≠
 * checker (§15), never a routine operational posting.
 *
 * The maker-supplied `amount` is the financial impact of THIS approved
 * request — never a value this service derives from quantity, a price, or
 * any valuation method. An automatically-computed adjustment amount would
 * require a real valuation source (F08) and is explicitly out of scope
 * here (ADR-040 D3): if a caller cannot state the amount itself, the
 * result is a rejected/refused submission, never an invented figure.
 */
@Injectable()
export class InventoryAdjustmentService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly approvals: ApprovalEngineService,
    private readonly financialEvents: FinancialEventService,
    private readonly registry: FinancialEventHandlerRegistry,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    // C6 (ADR-INV-05): optional and last - without them the service behaves exactly as before C6 (GL-only write-downs, physical_count_variance accepted).
    @Optional() @Inject(INVENTORY_VALUATION_CONTRACT) private readonly valuation?: InventoryValuationContract,
    @Optional() private readonly config?: ConfigurationEngineService,
  ) {}

  private flag(key: string, fallback: string): string {
    const v = this.config?.get<unknown>(key);
    return typeof v === 'string' ? v : typeof v === 'boolean' ? String(v) : fallback;
  }

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async onModuleInit(): Promise<void> {
    if (!this.registry.get(INVENTORY_ADJUSTMENT_APPROVED_EVENT)) {
      this.registry.register(INVENTORY_ADJUSTMENT_APPROVED_EVENT, (event, ctx) => handleInventoryAdjustmentApproved(event, ctx, { valuation: this.valuation }));
    }
    for (const [kind, meta] of Object.entries(INVENTORY_ADJUSTMENT_META)) {
      await this.approvals.registerRequestType(meta.requestTypeCode, `action.inventory_${kind}`);
      await this.approvals
        .upsertMatrixRule(
          {
            requestTypeCode: meta.requestTypeCode,
            minApprovers: meta.minApprovers,
            requiredPermissionNode: INVENTORY_APPROVER_PERMISSION_NODE,
            valueThreshold: null,
            orgUnitId: null,
          },
          SYSTEM_ACTOR,
        )
        .catch(() => undefined);
    }
    this.events.subscribe(
    'approval.request.approved',
    async (payload, ctx) => {
      await this.onApprovalApproved(payload as Record<string, unknown>, ctx.manager ?? undefined);
    },
    { scope: 'company' },
  );
  }

  // ---------------------------------------------------------------------------
  // Submit (maker)
  // ---------------------------------------------------------------------------

  async submitAdjustment(input: SubmitInventoryAdjustmentInput, actorUserId: string, manager?: EntityManager): Promise<{ mode: 'approval'; approvalRequestId: string }> {
    if (!isInventoryAdjustmentKind(input.kind)) throw new BadRequestException(`Unknown inventory adjustment kind "${input.kind}".`);
    if (!isPositiveAmount(input.amount)) throw new BadRequestException('Amount must be a positive decimal.');
    if (!input.reason?.trim()) throw new BadRequestException('A reason is required.');
    if (!input.counterAccountCode?.trim()) throw new BadRequestException('A counterAccountCode is required.');

    // C6 (ADR-INV-05 matrix): quantity changes belong to D3 count / adjustment DOCUMENTS; a physical-count variance is no longer a free-typed amount. `refused` answers 409 with a
    // pointer to the replacement; `warn` accepts it but records the deprecated use; `allowed` (default) is today's behaviour. Already-approved history is never touched.
    if (input.kind === 'physical_count_variance') {
      const mode = this.flag('accounting.inventory_physical_count_variance', 'allowed');
      if (mode === 'refused') {
        throw new ConflictException('A physical-count variance is a quantity change: post it with a stock count / adjustment document (Movement Center), which moves the stock, the valuation and the ledger together. A free-typed amount is no longer accepted here.');
      }
      if (mode === 'warn') {
        await this.audit.record({ actorUserId, organizationId: null, action: 'accounting.inventory.physical_count_variance_deprecated_submission', resource: 'inventory_adjustment', resourceId: (input.productId ?? input.warehouseId ?? 'inventory').slice(0, 64), result: 'success', correlationId: null, after: { amount: input.amount, mode: 'warn' } }, manager);
      }
    }

    // C6 (ADR-INV-05 2.1): a VALUE-ONLY write-down / write-up moves the valuation too (flag `accounting.inventory_f07_updates_valuation`, default off = pre-C6). It must name its position,
    // which must hold quantity, and a write-down cannot exceed the position's current value - all checked BEFORE any FA-01 request.
    let valuationEffect = false;
    if (input.kind === 'valuation_write_down' && this.flag('accounting.inventory_f07_updates_valuation', 'false') === 'true') {
      if (!input.productId || !input.warehouseId) throw new BadRequestException('A valuation adjustment must name its product and warehouse (productId and warehouseId).');
      if (!this.valuation?.getValuedPositions) throw new ConflictException('The valuation engine is not available: a valuation adjustment cannot be priced against a position.');
      const [position] = await this.valuation.getValuedPositions(undefined, { warehouseIds: [input.warehouseId], productId: input.productId }, this.em(manager));
      if (!position || position.quantity <= 0) throw new ConflictException('There is no valued stock for this product in this warehouse: a value-only adjustment needs a position with quantity on hand.');
      if ((input.direction ?? 'credit') === 'credit' && Math.round(Number(input.amount) * 10000) > Math.round(Number(position.totalValueBase) * 10000)) {
        throw new ConflictException(`A write-down of ${input.amount} exceeds the current value ${position.totalValueBase} of this position - a write-down cannot create a negative value.`);
      }
      valuationEffect = true;
    }

    // fail-closed BEFORE any FA-01 request
    const counterAccountCode = await this.requirePostableNonControlAccount(input.counterAccountCode.trim(), 'counterAccountCode', manager);
    const meta = INVENTORY_ADJUSTMENT_META[input.kind];

    const payload = {
      kind: input.kind,
      productId: input.productId ?? null,
      warehouseId: input.warehouseId ?? null,
      amount: input.amount,
      reason: input.reason.trim(),
      direction: input.direction ?? 'credit',
      counterAccountCode,
      businessDate: input.businessDate ?? new Date().toISOString().slice(0, 10),
      orgUnitId: input.orgUnitId ?? null,
      // decided at SUBMIT time and carried through the approval: a flag flipped meanwhile never changes what the approvers approved
      valuationEffect,
    };

    const request = await this.approvals.submit({
      requestTypeCode: meta.requestTypeCode,
      resourceType: 'InventoryAdjustment',
      resourceId: (input.productId ?? input.warehouseId ?? 'inventory').slice(0, 64),
      requestedAction: input.kind,
      payload,
      makerUserId: actorUserId,
      orgUnitId: input.orgUnitId ?? null,
    }, manager);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.inventory.adjustment_submitted',
      resource: 'approval_request',
      resourceId: request.id,
      result: 'success',
      correlationId: input.productId ?? null,
      after: { kind: input.kind, amount: input.amount, requestTypeCode: meta.requestTypeCode },
    }, manager);
    return { mode: 'approval', approvalRequestId: request.id };
  }

  // ---------------------------------------------------------------------------
  // FA-01 approval subscriber
  // ---------------------------------------------------------------------------

  private async onApprovalApproved(payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (!Object.values(INVENTORY_APPROVAL_REQUEST_TYPES).includes(requestTypeCode as never)) return; // not ours
    const inner = (payload.payload ?? {}) as Record<string, unknown>;
    await this.performApprovedAdjustment(inner, SYSTEM_ACTOR, String(payload.approvalRequestId ?? ''), manager);
  }

  private async performApprovedAdjustment(p: Record<string, unknown>, actorUserId: string, approvalRequestId: string, manager?: EntityManager): Promise<string> {
    const kind = String(p.kind) as InventoryAdjustmentKind;
    const resourceId = String(p.productId ?? p.warehouseId ?? 'inventory');

    const result = await this.financialEvents.ingest(INVENTORY_ADJUSTMENT_APPROVED_EVENT, {
      idempotencyKey: `accounting:inventory_adjustment:${approvalRequestId}`,
      businessDate: p.businessDate ?? new Date().toISOString().slice(0, 10),
      orgUnitId: p.orgUnitId ?? null,
      // C6: no hard-coded currency - the Company's base currency is resolved by the financial-event service when none is given (ADR-INV-05 2.1, G-F07-2).
      sourceEntityType: 'ledger_entry',
      sourceEntityId: resourceId.slice(0, 64),
      payloadVersion: 1,
      kind,
      amount: String(p.amount),
      reason: p.reason ?? '',
      direction: p.direction ?? 'credit',
      counterAccountCode: p.counterAccountCode ?? null,
      productId: p.productId ?? null,
      warehouseId: p.warehouseId ?? null,
      valuationEffect: p.valuationEffect === true,
    }, manager);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.inventory.adjustment_posted',
      resource: 'inventory_adjustment',
      resourceId: resourceId.slice(0, 64),
      result: result.status === 'POSTED' ? 'success' : 'failure',
      correlationId: approvalRequestId || null,
      after: { kind, amount: String(p.amount), financialEventId: result.financialEventId, status: result.status },
    }, manager);

    if (result.status === 'REJECTED') {
      throw new ConflictException(`Inventory ${kind} GL posting was rejected — see financial event ${result.financialEventId}.`);
    }
    return result.financialEventId;
  }

  // ---------------------------------------------------------------------------
  // Checker
  // ---------------------------------------------------------------------------

  async decide(requestId: string, approverUserId: string, decision: 'approved' | 'rejected', note?: string, manager?: EntityManager): Promise<unknown> {
    return this.approvals.decide(requestId, approverUserId, decision, note ?? null, manager);
  }

  // ---------------------------------------------------------------------------

  private async requirePostableNonControlAccount(code: string, label: string, manager?: EntityManager): Promise<string> {
    const acc = await this.em(manager).getRepository(GLAccount).findOne({ where: { code } });
    if (!acc) throw new BadRequestException(`${label}: GL account "${code}" not found.`);
    if (!acc.isActive) throw new BadRequestException(`${label}: GL account "${code}" is inactive.`);
    if (!acc.isPostable) throw new BadRequestException(`${label}: GL account "${code}" is not postable.`);
    if (acc.controlFunction) throw new BadRequestException(`${label}: GL account "${code}" is a control account — not valid here.`);
    return code;
  }
}
