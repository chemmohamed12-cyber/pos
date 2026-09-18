import { BadRequestException, ConflictException, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CASH_BANK_ADJUSTMENT_META,
  CASH_BANK_ADJUSTMENT_POSTING,
  CASH_BANK_APPROVAL_REQUEST_TYPES,
  CASH_BANK_APPROVER_PERMISSION_NODE,
  CashBankAdjustmentKind,
  isCashBankAdjustmentKind,
} from '../domain/cash-bank';
import { GLAccount } from '../infrastructure/gl-account.entity';
import { FinancialEventService } from './financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from './financial-events/handler-registry';
import { handleCashBankAdjustmentApproved } from './financial-events/cash-bank-adjustment.handler';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { FINANCE_TREASURY_CONTRACT, FinanceTreasuryContract } from '../../../foundation/module-registry/contracts/finance.contract';
import { CASH_BANK_ADJUSTMENT_APPROVED_EVENT } from '../../../foundation/module-registry/contracts/treasury-events.contract';
import { Inject } from '@nestjs/common';
import { isPositiveAmount } from '../domain/money';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';
const CLEARING_ACCOUNT_KEY = 'accounting.cash_movement_clearing_account_code';
const OPENING_BALANCE_KEY = 'accounting.cash_bank_opening_balance_account_code';
const THRESHOLD_KEY = 'accounting.cash_bank_adjustment_approval_threshold';

export interface SubmitCashBankAdjustmentInput {
  /** the Treasury account this adjustment concerns (for the approval resource + audit). */
  treasuryAccountId?: string | null;
  /** explicit target `bank` GL account code when the chart has more than one (the handler never guesses). */
  glAccountCode?: string | null;
  kind: CashBankAdjustmentKind;
  amount: string;
  reason: string;
  /** 'debit' | 'credit' — the primary (`bank`, or for reclassification the clearing) account movement. */
  direction?: 'debit' | 'credit';
  /** required for `bank_adjustment` / `unreconciled_write_off`. */
  counterAccountCode?: string | null;
  /** required for `reclassification`. */
  contraAccountCode?: string | null;
  businessDate?: string;
  orgUnitId?: string | null;
}

/**
 * F06 — Cash & Bank (ADR-038 D3/D5). Maker-checker for cash/bank
 * adjustments, **via FA-01** (no cash-specific approval engine). The
 * mirror of `ap-adjustment.service.ts`, with F04's threshold branch
 * (`bank_adjustment` / `reclassification` are threshold-gated).
 *
 * On approval / straight-through: an internal `FinancialEvent`
 * (`accounting.cash.adjustment.approved`) is ingested → F06's handler →
 * F03's posting gate → the `bank` control account. **No hard-coded
 * account codes** — the clearing/opening accounts come from config with
 * fail-closed validation at submit time; the counter/contra accounts are
 * maker-supplied.
 */
@Injectable()
export class CashBankAdjustmentService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly approvals: ApprovalEngineService,
    private readonly financialEvents: FinancialEventService,
    private readonly registry: FinancialEventHandlerRegistry,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly config: ConfigurationEngineService,
    @Optional() @Inject(FINANCE_TREASURY_CONTRACT) private readonly treasury?: FinanceTreasuryContract,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.registry.get(CASH_BANK_ADJUSTMENT_APPROVED_EVENT)) {
      this.registry.register(CASH_BANK_ADJUSTMENT_APPROVED_EVENT, handleCashBankAdjustmentApproved);
    }
    for (const [kind, meta] of Object.entries(CASH_BANK_ADJUSTMENT_META)) {
      await this.approvals.registerRequestType(meta.requestTypeCode, `action.cash_${kind}`);
      await this.approvals
        .upsertMatrixRule(
          {
            requestTypeCode: meta.requestTypeCode,
            minApprovers: meta.minApprovers,
            requiredPermissionNode: CASH_BANK_APPROVER_PERMISSION_NODE,
            valueThreshold: null,
            orgUnitId: null,
          },
          SYSTEM_ACTOR,
        )
        .catch(() => undefined);
    }
    this.events.subscribe('approval.request.approved', async (payload) => {
      await this.onApprovalApproved(payload);
    });
  }

  // ---------------------------------------------------------------------------
  // Submit (maker)
  // ---------------------------------------------------------------------------

  async submitAdjustment(
    input: SubmitCashBankAdjustmentInput,
    actorUserId: string,
  ): Promise<{ mode: 'approval'; approvalRequestId: string } | { mode: 'straight_through'; financialEventId: string }> {
    if (!isCashBankAdjustmentKind(input.kind)) throw new BadRequestException(`Unknown cash/bank adjustment kind "${input.kind}".`);
    if (!isPositiveAmount(input.amount)) throw new BadRequestException('Amount must be a positive decimal.');
    if (!input.reason?.trim()) throw new BadRequestException('A reason is required.');

    const meta = CASH_BANK_ADJUSTMENT_META[input.kind];
    const posting = CASH_BANK_ADJUSTMENT_POSTING[input.kind];
    const direction = input.direction ?? posting.bankDirection;

    // per-kind account resolution — fail-closed BEFORE any FA-01 request
    let counterAccountCode: string | null = null;
    let contraAccountCode: string | null = null;
    let openingBalanceAccountCode: string | null = null;
    let clearingAccountCode: string | null = null;

    if (input.kind === 'bank_adjustment' || input.kind === 'unreconciled_write_off') {
      if (!input.counterAccountCode?.trim()) {
        throw new BadRequestException(`A "${input.kind}" requires a counterAccountCode.`);
      }
      counterAccountCode = await this.requirePostableNonControlAccount(input.counterAccountCode.trim(), 'counterAccountCode');
    } else if (input.kind === 'reclassification') {
      if (!input.contraAccountCode?.trim()) {
        throw new BadRequestException('A "reclassification" requires a contraAccountCode.');
      }
      contraAccountCode = await this.requirePostableNonControlAccount(input.contraAccountCode.trim(), 'contraAccountCode');
      clearingAccountCode = await this.requireConfiguredAccount(CLEARING_ACCOUNT_KEY);
    } else if (input.kind === 'opening_balance') {
      openingBalanceAccountCode = await this.requireConfiguredAccount(OPENING_BALANCE_KEY);
    }

    // resolve the target `bank` GL account: explicit code wins; else the
    // mapped Treasury account's `glAccountCode` (so a maker who picked a
    // Treasury account never needs to know a chart code); else the handler
    // falls back to the single `bank` control account.
    let glAccountCode = input.glAccountCode?.trim() || null;
    if (!glAccountCode && input.treasuryAccountId && this.treasury) {
      const { balances } = await this.treasury.getAllTreasuryBalances();
      glAccountCode = balances.find((b) => b.treasuryAccountId === input.treasuryAccountId)?.glAccountCode ?? null;
    }

    const threshold = this.resolveThreshold();
    const gated = meta.alwaysGated || threshold === null || Number(input.amount) > Number(threshold);

    const payload = {
      kind: input.kind,
      glAccountCode,
      amount: input.amount,
      reason: input.reason.trim(),
      direction,
      counterAccountCode,
      contraAccountCode,
      openingBalanceAccountCode,
      clearingAccountCode,
      treasuryAccountId: input.treasuryAccountId ?? null,
      businessDate: input.businessDate ?? new Date().toISOString().slice(0, 10),
      orgUnitId: input.orgUnitId ?? null,
    };

    if (!gated) {
      const financialEventId = await this.performApprovedAdjustment(payload, actorUserId);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'accounting.cash.adjustment_straight_through',
        resource: 'cash_bank',
        resourceId: input.treasuryAccountId ?? input.glAccountCode ?? 'cash-bank',
        result: 'success',
        correlationId: null,
        after: { kind: input.kind, amount: input.amount },
      });
      return { mode: 'straight_through', financialEventId };
    }

    const request = await this.approvals.submit({
      requestTypeCode: meta.requestTypeCode,
      resourceType: 'CashBank',
      resourceId: (input.treasuryAccountId ?? input.glAccountCode ?? 'cash-bank').slice(0, 64),
      requestedAction: input.kind,
      payload,
      makerUserId: actorUserId,
      orgUnitId: input.orgUnitId ?? null,
    });
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.cash.adjustment_submitted',
      resource: 'approval_request',
      resourceId: request.id,
      result: 'success',
      correlationId: input.treasuryAccountId ?? null,
      after: { kind: input.kind, amount: input.amount, requestTypeCode: meta.requestTypeCode },
    });
    return { mode: 'approval', approvalRequestId: request.id };
  }

  // ---------------------------------------------------------------------------
  // FA-01 approval subscriber
  // ---------------------------------------------------------------------------

  private async onApprovalApproved(payload: Record<string, unknown>): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (!Object.values(CASH_BANK_APPROVAL_REQUEST_TYPES).includes(requestTypeCode as never)) return; // not ours
    const inner = (payload.payload ?? {}) as Record<string, unknown>;
    await this.performApprovedAdjustment(inner, SYSTEM_ACTOR, String(payload.approvalRequestId ?? ''));
  }

  private async performApprovedAdjustment(p: Record<string, unknown>, actorUserId: string, approvalRequestId = ''): Promise<string> {
    const kind = String(p.kind) as CashBankAdjustmentKind;
    const treasuryAccountId = p.treasuryAccountId ? String(p.treasuryAccountId) : null;
    const idBase = approvalRequestId || `${treasuryAccountId ?? p.glAccountCode ?? 'cash'}:${kind}:${p.amount}:${p.businessDate}`;

    const result = await this.financialEvents.ingest(CASH_BANK_ADJUSTMENT_APPROVED_EVENT, {
      idempotencyKey: `accounting:cash_adjustment:${idBase}`,
      businessDate: p.businessDate ?? new Date().toISOString().slice(0, 10),
      orgUnitId: p.orgUnitId ?? null,
      currency: 'EGP',
      sourceEntityType: 'ledger_entry',
      sourceEntityId: (treasuryAccountId ?? String(p.glAccountCode ?? 'cash-bank')).slice(0, 64),
      payloadVersion: 1,
      kind,
      glAccountCode: p.glAccountCode ?? null,
      amount: String(p.amount),
      reason: p.reason ?? '',
      direction: p.direction ?? 'debit',
      counterAccountCode: p.counterAccountCode ?? null,
      contraAccountCode: p.contraAccountCode ?? null,
      openingBalanceAccountCode: p.openingBalanceAccountCode ?? null,
      clearingAccountCode: p.clearingAccountCode ?? null,
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.cash.adjustment_posted',
      resource: 'cash_bank',
      resourceId: (treasuryAccountId ?? String(p.glAccountCode ?? 'cash-bank')).slice(0, 64),
      result: result.status === 'POSTED' ? 'success' : 'failure',
      correlationId: approvalRequestId || null,
      after: { kind, amount: String(p.amount), financialEventId: result.financialEventId, status: result.status },
    });

    if (result.status === 'REJECTED') {
      throw new ConflictException(`Cash/Bank ${kind} GL posting was rejected — see financial event ${result.financialEventId}.`);
    }
    return result.financialEventId;
  }

  // ---------------------------------------------------------------------------
  // Checker
  // ---------------------------------------------------------------------------

  async decide(requestId: string, approverUserId: string, decision: 'approved' | 'rejected', note?: string): Promise<unknown> {
    return this.approvals.decide(requestId, approverUserId, decision, note ?? null);
  }

  // ---------------------------------------------------------------------------

  /** `''` / non-numeric → null (fail-closed = always gated). */
  private resolveThreshold(): string | null {
    const raw = (this.config.get<string>(THRESHOLD_KEY) ?? '').trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? raw : null;
  }

  /** A config-keyed account code — fail-closed: exists + active + postable + no controlFunction. */
  private async requireConfiguredAccount(configKey: string): Promise<string> {
    const code = (this.config.get<string>(configKey) ?? '').trim();
    if (!code) {
      throw new BadRequestException(`Config "${configKey}" is not set — set it to a postable non-control GL account code before submitting this adjustment.`);
    }
    return this.requirePostableNonControlAccount(code, configKey);
  }

  private async requirePostableNonControlAccount(code: string, label: string): Promise<string> {
    const acc = await this.dataSource.getRepository(GLAccount).findOne({ where: { code } });
    if (!acc) throw new BadRequestException(`${label}: GL account "${code}" not found.`);
    if (!acc.isActive) throw new BadRequestException(`${label}: GL account "${code}" is inactive.`);
    if (!acc.isPostable) throw new BadRequestException(`${label}: GL account "${code}" is not postable.`);
    if (acc.controlFunction) throw new BadRequestException(`${label}: GL account "${code}" is a control account — not valid here.`);
    return code;
  }
}
