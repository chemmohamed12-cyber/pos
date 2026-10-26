import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CustodyExpense } from '../infrastructure/custody-expense.entity';
import { DeliveryService } from './delivery.service';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { FINANCE_TREASURY_CONTRACT, FinanceTreasuryContract } from '../../../foundation/module-registry/contracts/finance.contract';
import { TREASURY_DISBURSEMENT_REASON_ACCOUNTS_KEY, TREASURY_DOCUMENT_APPROVER_NODE } from '../../treasury/domain/treasury-document';

export const CUSTODY_EXPENSE_APPROVAL_REQUEST_TYPE = 'logistics.custody_expense';
export const CUSTODY_EXPENSE_RESOURCE_TYPE = 'CustodyExpense';
/** Only reason codes with this prefix can be claimed by a driver, so an ordinary disbursement reason (salaries, supplier refunds, ...) can never be claimed as a custody expense. */
export const CUSTODY_EXPENSE_CATEGORY_PREFIX = 'custody_';
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

export interface ClaimExpenseInput {
  shipmentId: string;
  category: string;
  amount: string;
  reason: string;
  incurredOn?: string | null;
  evidenceAssetId?: string | null;
  clientKey?: string | null;
}

/**
 * Vehicle Driver Workspace, Stage C / C3 (D-4, D-5) - expenses paid out of the cash a driver carries.
 *  - CLAIM (the driver, or an admin acting for him): validated against the company's own disbursement posting profile - the category must be a mapped `custody_*` reason and the
 *    vehicle's custody account must be GL-mapped, otherwise the claim is refused (fail closed; no account is guessed). Immediately submitted to the FA-01 approval engine.
 *  - APPROVE (a DIFFERENT person - the engine enforces maker != checker and the live `finance.cash_document.approve` check). EVERY expense needs it; there is no auto-approve limit.
 *  - POST (an explicit action by someone with `finance.cash_document.execute`): the existing Treasury cash-out from the custody account (balance check, lock, Financial Event, audit).
 *    A retry of a posted expense changes nothing. Recording, approval and posting stay three separate facts.
 * Policy (CTO 2026-10-26, SEPARATE EXPENSE FLOAT): expenses are paid only from the vehicle's own float account, funded and replenished by ordinary Treasury transfer documents;
 * customer collections are never used, netted or consumed, and remittance stays gross.
 */
@Injectable()
export class CustodyExpenseService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly delivery: DeliveryService,
    private readonly shipments: ShipmentService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalEngineService,
    private readonly config: ConfigurationEngineService,
    @Inject(FINANCE_TREASURY_CONTRACT) private readonly treasury: FinanceTreasuryContract,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.approvals.registerRequestType(CUSTODY_EXPENSE_APPROVAL_REQUEST_TYPE, 'action.custody_expense').catch(() => undefined);
    await this.approvals
      .upsertMatrixRule(
        { requestTypeCode: CUSTODY_EXPENSE_APPROVAL_REQUEST_TYPE, minApprovers: 1, requiredPermissionNode: TREASURY_DOCUMENT_APPROVER_NODE, valueThreshold: null, orgUnitId: null },
        SYSTEM_ACTOR,
      )
      .catch(() => undefined);
    this.events.subscribe('approval.request.approved', async (payload, ctx) => this.onApprovalDecided('approved', payload as Record<string, unknown>, ctx.manager ?? undefined), { scope: 'company' });
    this.events.subscribe('approval.request.rejected', async (payload, ctx) => this.onApprovalDecided('rejected', payload as Record<string, unknown>, ctx.manager ?? undefined), { scope: 'company' });
  }

  private readMap(): Record<string, string> {
    const raw = this.config.get<unknown>(TREASURY_DISBURSEMENT_REASON_ACCOUNTS_KEY);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
  }

  /** The categories a driver may choose: the mapped `custody_*` reasons of the company's disbursement profile (codes only - never the accounts behind them). */
  listCategories(): string[] {
    const map = this.readMap();
    return Object.keys(map)
      .filter((k) => k.startsWith(CUSTODY_EXPENSE_CATEGORY_PREFIX) && !!map[k])
      .sort();
  }

  async claim(input: ClaimExpenseInput, actorUserId: string, manager?: EntityManager): Promise<CustodyExpense> {
    await this.shipments.assertDriverOrAdmin(input.shipmentId, actorUserId, manager);
    const category = (input.category ?? '').trim();
    if (!/^custody_[a-z0-9_]{1,56}$/.test(category)) throw new BadRequestException('The category must be a custody_* reason code of the company posting profile.');
    if (!this.readMap()[category]) {
      throw new ConflictException(`The category "${category}" has no account in the company posting profile (${TREASURY_DISBURSEMENT_REASON_ACCOUNTS_KEY}). Ask Accounting to map it first. Nothing was recorded.`);
    }
    if (typeof input.amount !== 'string' || !/^\d+(\.\d{1,2})?$/.test(input.amount) || Number(input.amount) <= 0) {
      throw new BadRequestException('The amount must be a positive number with at most two decimals.');
    }
    const reason = (input.reason ?? '').trim();
    if (reason.length < 3 || reason.length > 255) throw new BadRequestException('A reason of 3-255 characters is required.');
    const today = new Date().toISOString().slice(0, 10);
    const incurredOn = input.incurredOn ?? today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(incurredOn) || Number.isNaN(Date.parse(incurredOn))) throw new BadRequestException('incurredOn must be YYYY-MM-DD.');
    if (incurredOn > today) throw new BadRequestException('An expense cannot be dated in the future.');
    const evidence = input.evidenceAssetId ?? null;
    if (evidence !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(evidence)) throw new BadRequestException('evidenceAssetId must be a UUID.');
    const clientKey = input.clientKey ?? null;
    if (clientKey !== null && !/^[A-Za-z0-9_.:-]{8,64}$/.test(clientKey)) throw new BadRequestException('clientKey must be 8-64 characters (letters, digits, _ . : -).');

    let replayed = false;
    const saved = await (manager ?? this.dataSource).transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`delivery:expense:${input.shipmentId}`]);
      const repo = tx.getRepository(CustodyExpense);
      if (clientKey) {
        const prior = await repo.findOne({ where: { clientKey } });
        if (prior) {
          if (prior.shipmentId !== input.shipmentId || prior.claimedByUserId !== actorUserId || Number(prior.amount) !== Number(input.amount) || prior.category !== category) {
            throw new ConflictException('This clientKey was already used for a different expense.');
          }
          replayed = true;
          return prior;
        }
      }
      // Separate EXPENSE FLOAT (CTO policy 2026-10-26): expenses are paid from the vehicle's float account only - never from the collection custody account. Fail closed on every gap.
      const snap = await this.shipments.getShipmentSnapshot(input.shipmentId, tx);
      if (!snap?.vehicleId) throw new ConflictException('This shipment has no vehicle - expenses are paid from a vehicle expense float. Nothing was recorded.');
      const vehicle = await this.shipments.getVehicle(snap.vehicleId, tx);
      const floatAccountId = vehicle.expenseFloatAccountId;
      if (!floatAccountId) throw new ConflictException('No expense float is assigned to this vehicle - assign one (and fund it by a Treasury transfer) before claiming expenses. Nothing was recorded.');
      if (floatAccountId === vehicle.custodyAccountId || floatAccountId === vehicle.settlementAccountId) {
        throw new ConflictException('The expense float of this vehicle is a collection account - refused. Nothing was recorded.');
      }
      const { balances } = await this.treasury.getAllTreasuryBalances(undefined, tx);
      if (!balances.find((b) => b.treasuryAccountId === floatAccountId)?.glAccountCode) {
        throw new ConflictException('The expense float account of this vehicle is not GL-mapped - Accounting must map it before expenses can be claimed. Nothing was recorded.');
      }
      const custody = await this.delivery.openCustody(input.shipmentId, actorUserId, tx);
      await this.numbering.registerDocumentType('custody_expense', 'CEX', true, tx);
      const expenseNumber = await this.numbering.getNextNumber('custody_expense', tx);
      return repo.save(
        repo.create({
          expenseNumber,
          custodyId: custody.id,
          shipmentId: input.shipmentId,
          vehicleId: custody.vehicleId,
          floatAccountId,
          category,
          amount: input.amount,
          reason,
          incurredOn,
          evidenceAssetId: evidence,
          status: 'pending_approval',
          claimedByUserId: actorUserId,
          clientKey,
        }),
      );
    });
    if (replayed) return saved;

    // The approval request is created after the claim committed (same order as Treasury documents). If the engine refuses, the claim is cancelled with that reason - never left
    // dangling in "pending approval" with nobody able to approve it.
    try {
      const request = await this.approvals.submit(
        {
          requestTypeCode: CUSTODY_EXPENSE_APPROVAL_REQUEST_TYPE,
          resourceType: CUSTODY_EXPENSE_RESOURCE_TYPE,
          resourceId: saved.id,
          requestedAction: 'custody_expense',
          payload: { amount: saved.amount, category, expenseNumber: saved.expenseNumber },
          makerUserId: actorUserId,
        },
        manager,
      );
      await (manager ?? this.dataSource).getRepository(CustodyExpense).update({ id: saved.id }, { approvalRequestId: request.id });
      saved.approvalRequestId = request.id;
    } catch (e) {
      await (manager ?? this.dataSource).getRepository(CustodyExpense).update({ id: saved.id }, { status: 'cancelled', cancelReason: 'the approval request could not be created' });
      throw e;
    }
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'delivery.custody_expense.claimed', resource: 'custody_expense', resourceId: saved.id, result: 'success', correlationId: null, after: { expenseNumber: saved.expenseNumber, category, amount: saved.amount, shipmentId: saved.shipmentId } },
      manager,
    );
    return saved;
  }

  /** The approver's decision, through the FA-01 engine (maker != checker and the live permission check are enforced THERE). */
  async decide(id: string, approverUserId: string, decision: 'approved' | 'rejected', note: string | undefined, manager?: EntityManager): Promise<CustodyExpense> {
    const repo = (manager ?? this.dataSource).getRepository(CustodyExpense);
    const row = await repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Expense "${id}" not found.`);
    if (row.status !== 'pending_approval' || !row.approvalRequestId) throw new ConflictException(`This expense is "${row.status}" - nothing is waiting for a decision.`);
    await this.approvals.decide(row.approvalRequestId, approverUserId, decision, note ?? null, manager);
    return (await repo.findOne({ where: { id } }))!;
  }

  private async onApprovalDecided(decision: 'approved' | 'rejected', payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    if (payload.resourceType !== CUSTODY_EXPENSE_RESOURCE_TYPE) return;
    const id = String(payload.resourceId ?? '');
    const requestId = String(payload.approvalRequestId ?? '');
    const em = manager ?? this.dataSource.manager;
    await em.transaction(async (m) => {
      const row = await m.getRepository(CustodyExpense).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!row || row.status !== 'pending_approval' || row.approvalRequestId !== requestId) return; // stale / replayed event
      const decided: Array<{ approverUserId: string; note: string | null }> = await m.query(
        `SELECT "approverUserId", note FROM approval_decisions WHERE "approvalRequestId" = $1 AND decision = $2 ORDER BY "decidedAt" DESC LIMIT 1`,
        [requestId, decision],
      );
      row.status = decision === 'approved' ? 'approved' : 'rejected';
      row.decidedByUserId = decided[0]?.approverUserId ?? null;
      row.decidedAt = new Date();
      row.decisionNote = decided[0]?.note?.slice(0, 255) ?? null;
      await m.getRepository(CustodyExpense).save(row);
      await this.audit.record(
        { actorUserId: decided[0]?.approverUserId ?? SYSTEM_ACTOR, organizationId: null, action: `delivery.custody_expense.${decision}`, resource: 'custody_expense', resourceId: id, result: 'success', correlationId: requestId, after: { status: row.status } },
        m,
      );
    });
  }

  /** The only action that moves money: the existing Treasury cash-out from the custody account. Idempotent for an already-posted expense. */
  async post(id: string, actorUserId: string, manager?: EntityManager): Promise<CustodyExpense> {
    let didPost = false;
    const row = await (manager ?? this.dataSource).transaction(async (tx) => {
      const repo = tx.getRepository(CustodyExpense);
      const locked = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!locked) throw new NotFoundException(`Expense "${id}" not found.`);
      if (locked.status === 'posted') return locked;
      if (locked.status !== 'approved') throw new ConflictException(`Only an approved expense can be posted - this one is "${locked.status}".`);
      const leg = await this.treasury.cashOutForCustodyExpense(
        locked.floatAccountId,
        locked.amount,
        locked.expenseNumber,
        `${locked.category}: ${locked.reason}`,
        actorUserId,
        tx,
        { configKey: TREASURY_DISBURSEMENT_REASON_ACCOUNTS_KEY, reasonCode: locked.category },
      );
      locked.status = 'posted';
      locked.postedByUserId = actorUserId;
      locked.postedAt = new Date();
      locked.treasuryTransactionId = leg.id;
      didPost = true;
      return repo.save(locked);
    });
    if (didPost) {
      await this.events.dispatchAfterCommit(manager);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'delivery.custody_expense.posted', resource: 'custody_expense', resourceId: id, result: 'success', correlationId: null, after: { expenseNumber: row.expenseNumber, amount: row.amount, treasuryTransactionId: row.treasuryTransactionId, approvedBy: row.decidedByUserId } },
        manager,
      );
    }
    return row;
  }

  /**
   * Reverses a POSTED expense (finance, with a reason): the Treasury owner-reversal of the float cash-out with the same posting-profile counter - an append-only offsetting leg and a
   * reversal journal - and the expense becomes `reversed` (history kept). Idempotent for an already-reversed expense. Never touches customer collections.
   */
  async reverse(id: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<CustodyExpense> {
    const why = (reason ?? '').trim();
    if (why.length < 3 || why.length > 255) throw new BadRequestException('A reason of 3-255 characters is required.');
    let didReverse = false;
    const row = await (manager ?? this.dataSource).transaction(async (tx) => {
      const repo = tx.getRepository(CustodyExpense);
      const locked = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!locked) throw new NotFoundException(`Expense "${id}" not found.`);
      if (locked.status === 'reversed') return locked;
      if (locked.status !== 'posted' || !locked.treasuryTransactionId) throw new ConflictException(`Only a posted expense can be reversed - this one is "${locked.status}".`);
      const leg = await this.treasury.reverseCustodyExpense(locked.treasuryTransactionId, `${locked.expenseNumber}: ${why}`, actorUserId, tx, { configKey: TREASURY_DISBURSEMENT_REASON_ACCOUNTS_KEY, reasonCode: locked.category });
      locked.status = 'reversed';
      locked.reversedByUserId = actorUserId;
      locked.reversedAt = new Date();
      locked.reversalReason = why;
      locked.reversalTransactionId = leg.id;
      didReverse = true;
      return repo.save(locked);
    });
    if (didReverse) {
      await this.events.dispatchAfterCommit(manager);
      await this.audit.record({ actorUserId, organizationId: null, action: 'delivery.custody_expense.reversed', resource: 'custody_expense', resourceId: id, result: 'success', correlationId: null, after: { expenseNumber: row.expenseNumber, amount: row.amount, reason: why, reversalTransactionId: row.reversalTransactionId } }, manager);
    }
    return row;
  }

  /** The claimant withdraws a claim that has not been posted (no money has moved before posting). */
  async cancel(id: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<CustodyExpense> {
    const why = (reason ?? '').trim();
    if (why.length < 3 || why.length > 255) throw new BadRequestException('A reason of 3-255 characters is required.');
    let withdraw: string | null = null;
    const row = await (manager ?? this.dataSource).transaction(async (tx) => {
      const repo = tx.getRepository(CustodyExpense);
      const locked = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!locked) throw new NotFoundException(`Expense "${id}" not found.`);
      if (locked.status === 'cancelled') return locked;
      if (locked.claimedByUserId !== actorUserId) throw new ForbiddenException('Only the person who claimed the expense can cancel it.');
      if (locked.status !== 'pending_approval' && locked.status !== 'approved') throw new ConflictException(`An expense that is "${locked.status}" cannot be cancelled.`);
      if (locked.status === 'pending_approval') withdraw = locked.approvalRequestId;
      locked.status = 'cancelled';
      locked.cancelReason = why;
      return repo.save(locked);
    });
    if (withdraw) await this.approvals.withdraw(withdraw, actorUserId, manager).catch(() => undefined);
    await this.audit.record({ actorUserId, organizationId: null, action: 'delivery.custody_expense.cancelled', resource: 'custody_expense', resourceId: id, result: 'success', correlationId: null, after: { reason: why } }, manager);
    return row;
  }

  /** Every expense of a shipment (driver-or-admin scoped). */
  async listForShipment(shipmentId: string, actorUserId: string, manager?: EntityManager): Promise<CustodyExpense[]> {
    await this.shipments.assertDriverOrAdmin(shipmentId, actorUserId, manager);
    return this.listForShipmentUnscoped(shipmentId, manager);
  }

  async listForShipmentUnscoped(shipmentId: string, manager?: EntityManager): Promise<CustodyExpense[]> {
    return (manager ?? this.dataSource).getRepository(CustodyExpense).find({ where: { shipmentId }, order: { createdAt: 'ASC', id: 'ASC' } });
  }
}
