import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Deposit } from '../infrastructure/deposit.entity';
import { canTransitionDepositStatus } from '../domain/deposit-status';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { InvoiceService } from '../../customer-finance/application/invoices.service';

const CURRENCY = 'EGP'; // Daii is Egypt-focused per the blueprint; not a general multi-currency system for V1.

@Injectable()
export class DepositsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly salesOrders: SalesOrdersService,
    private readonly treasury: TreasuryService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly customerLedger: CustomerLedgerService,
    private readonly invoices: InvoiceService,
  ) {}

  async submitDeposit(
    salesOrderId: string,
    amount: string,
    method: string,
    reference: string | null,
    evidenceMediaAssetId: string | null,
    submittedByUserId: string,
  ): Promise<Deposit> {
    // V1 Release Audit MEDIUM fix — no scope check previously; reuses
    // SalesOrdersService.getOrder's existing check (reviewer roles pass,
    // otherwise Scope must include this order) rather than duplicating
    // it, which also confirms the order actually exists.
    await this.salesOrders.getOrder(salesOrderId, submittedByUserId);

    const deposit = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Deposit);
      const saved = await repo.save(
        repo.create({
          salesOrderId,
          amount,
          method,
          reference,
          evidenceMediaAssetId,
          status: 'submitted',
          submittedByUserId,
        }),
      );
      await this.events.publish(manager, 'deposit.submitted', {
        depositId: saved.id,
        salesOrderId,
        amount,
        method,
      });
      return saved;
    });

    await this.audit.record({
      actorUserId: submittedByUserId,
      organizationId: null,
      action: 'deposit.submitted',
      resource: 'deposit',
      resourceId: deposit.id,
      result: 'success',
      correlationId: null,
      after: { salesOrderId, amount, method },
    });

    return deposit;
  }

  /**
   * Approves a deposit and releases its Sales Order for fulfillment
   * (blueprint §15's Order Released step). Finance-sufficient event
   * payload per ADR-018 — Finance Phase 2 can act on `deposit.verified`
   * without ever calling back into Sales Orders or Deposit Control.
   *
   * Treasury Core wiring: approving a deposit IS the control point for
   * the resulting financial transaction — there's no separate approval
   * on the Treasury side. Order matters here, most-likely-to-fail-first
   * (validate-before-commit, the same discipline as Warehouse's atomic-
   * posting fix): the order's Process Engine state is checked BEFORE
   * anything financial happens, since `releaseAfterDepositVerified`
   * failing AFTER the treasury transaction was already posted would
   * leave real ledger movement with no corresponding release — found
   * live in this feature's own verification, not a theoretical worry.
   * `createDepositTransaction` still runs before the deposit itself is
   * marked approved, so an invalid/inactive `treasuryAccountId` also
   * fails cleanly with nothing changed. Cross-domain calls here are
   * sequential, not one shared transaction (this codebase never wraps
   * Deposit Control + Sales Orders + Treasury in a single transaction
   * across module boundaries — same pattern Warehouse uses calling into
   * Inventory), so this ordering narrows the failure window rather than
   * eliminating it outright.
   */
  async approveDeposit(depositId: string, actorUserId: string, treasuryAccountId: string): Promise<Deposit> {
    const repo = this.dataSource.getRepository(Deposit);
    const deposit = await repo.findOne({ where: { id: depositId } });
    if (!deposit) throw new NotFoundException(`Deposit "${depositId}" not found.`);
    if (!canTransitionDepositStatus(deposit.status, 'approved')) {
      throw new ConflictException(`Cannot approve a deposit in status "${deposit.status}".`);
    }

    const order = await this.salesOrders.getOrder(deposit.salesOrderId, actorUserId);
    const orderStatus = await this.salesOrders.getOrderStatus(deposit.salesOrderId);
    if (orderStatus !== 'deposit_verification') {
      throw new ConflictException(`Cannot approve this deposit — order "${deposit.salesOrderId}" is in status "${orderStatus}", not awaiting deposit verification.`);
    }

    const treasuryTxn = await this.treasury.createDepositTransaction(depositId, deposit.salesOrderId, order.customerId, deposit.amount, treasuryAccountId, actorUserId);

    // Customer Financial Account / AR (CTO directive) — the existing
    // Deposit/Treasury flow is reused as-is; this only ADDS the Customer
    // Ledger entry on top. If an invoice already exists for this order
    // and is posted (an edge case — deposits normally precede invoicing),
    // link directly; otherwise post unapplied and let `InvoiceService.
    // postInvoice`'s own sweep pick it up later.
    const existingInvoice = await this.invoices.findOpenInvoiceForOrder(deposit.salesOrderId);
    const existingInvoiceState = existingInvoice ? await this.invoices.getStatus(existingInvoice.id) : null;
    const linkedInvoiceId = existingInvoiceState === 'posted' || existingInvoiceState === 'partially_paid' ? existingInvoice!.id : null;

    await this.customerLedger.postEntry({
      customerId: order.customerId,
      entryType: 'deposit',
      direction: 'credit',
      amount: deposit.amount,
      salesOrderId: deposit.salesOrderId,
      invoiceId: linkedInvoiceId,
      depositId,
      treasuryTransactionId: treasuryTxn.id,
      reference: depositId,
      reason: `Customer deposit (${deposit.method})`,
      createdByUserId: actorUserId,
    });
    if (linkedInvoiceId) await this.invoices.recomputeStatus(linkedInvoiceId, actorUserId);

    deposit.status = 'approved';
    deposit.reviewedByUserId = actorUserId;
    const saved = await repo.save(deposit);

    await this.salesOrders.releaseAfterDepositVerified(deposit.salesOrderId, actorUserId);

    await this.dataSource.transaction(async (manager) => {
      await this.events.publish(manager, 'deposit.verified', {
        depositId: saved.id,
        salesOrderId: deposit.salesOrderId,
        customerId: order.customerId,
        amount: deposit.amount,
        currency: CURRENCY,
        method: deposit.method,
        reference: deposit.reference,
        verifiedByUserId: actorUserId,
        businessDate: new Date().toISOString(),
      });
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'deposit.verified',
      resource: 'deposit',
      resourceId: depositId,
      result: 'success',
      correlationId: null,
      after: { status: 'approved', salesOrderId: deposit.salesOrderId },
    });

    return saved;
  }

  /**
   * Rejects a deposit — the Sales Order stays in `deposit_verification`
   * (no Process Engine transition; rejection isn't a state the order
   * itself needs to model, only the deposit does). The rep resubmits by
   * calling `submitDeposit` again for the same order; `getLatestDepositForOrder`
   * (ordered by `createdAt DESC`) naturally picks up the new one, so no
   * separate "resubmit" endpoint is needed — it's the same submit path.
   */
  async rejectDeposit(depositId: string, reason: string, actorUserId: string): Promise<Deposit> {
    const repo = this.dataSource.getRepository(Deposit);
    const deposit = await repo.findOne({ where: { id: depositId } });
    if (!deposit) throw new NotFoundException(`Deposit "${depositId}" not found.`);
    if (!canTransitionDepositStatus(deposit.status, 'rejected')) {
      throw new ConflictException(`Cannot reject a deposit in status "${deposit.status}".`);
    }

    deposit.status = 'rejected';
    deposit.reviewedByUserId = actorUserId;
    deposit.rejectionReason = reason;
    const saved = await repo.save(deposit);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'deposit.rejected',
      resource: 'deposit',
      resourceId: depositId,
      result: 'success',
      correlationId: null,
      after: { status: 'rejected', salesOrderId: deposit.salesOrderId, reason },
    });

    return saved;
  }

  /** V1 Release Audit MEDIUM fix (IDOR) — exposed payment amount/method/reference/evidence for any order to any authenticated user. */
  async getDeposit(depositId: string, requestingUserId: string): Promise<Deposit> {
    const deposit = await this.dataSource.getRepository(Deposit).findOne({ where: { id: depositId } });
    if (!deposit) throw new NotFoundException(`Deposit "${depositId}" not found.`);
    await this.salesOrders.getOrder(deposit.salesOrderId, requestingUserId);
    return deposit;
  }

  /** Backs the Sales Order detail screen's deposit panel — most recent deposit for an order, or null before one is ever submitted. V1 Release Audit MEDIUM fix (IDOR): same missing check as getDeposit. */
  async getLatestDepositForOrder(salesOrderId: string, requestingUserId: string): Promise<Deposit | null> {
    await this.salesOrders.getOrder(salesOrderId, requestingUserId);
    return this.dataSource
      .getRepository(Deposit)
      .findOne({ where: { salesOrderId }, order: { createdAt: 'DESC' } });
  }

  /**
   * Every deposit attempt for an order (a rejected-then-resubmitted order
   * has more than one row) — same scope check as `getLatestDepositForOrder`,
   * distinct method because the Customer Account statement (CTO directive
   * — Customer Account Foundation) needs the full deposit history, not
   * just the latest.
   */
  async listDepositsForOrder(salesOrderId: string, requestingUserId: string): Promise<Deposit[]> {
    await this.salesOrders.getOrder(salesOrderId, requestingUserId);
    return this.dataSource.getRepository(Deposit).find({ where: { salesOrderId }, order: { createdAt: 'ASC' } });
  }
}
