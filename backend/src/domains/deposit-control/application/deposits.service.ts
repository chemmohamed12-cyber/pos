import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Deposit } from '../infrastructure/deposit.entity';
import { canTransitionDepositStatus } from '../domain/deposit-status';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import {
  FINANCE_TREASURY_CONTRACT,
  FinanceTreasuryContract,
  FINANCE_CUSTOMER_LEDGER_CONTRACT,
  FinanceCustomerLedgerContract,
  FINANCE_INVOICE_CONTRACT,
  FinanceInvoiceContract,
} from '../../../foundation/module-registry/contracts/finance.contract';
import { SalesDepositContract } from '../../../foundation/module-registry/contracts/sales.contract';

const CURRENCY = 'EGP'; // Daii is Egypt-focused per the blueprint; not a general multi-currency system for V1.

@Injectable()
export class DepositsService implements SalesDepositContract {
  constructor(
    private readonly dataSource: DataSource,
    private readonly salesOrders: SalesOrdersService,
    @Inject(FINANCE_TREASURY_CONTRACT) private readonly treasury: FinanceTreasuryContract,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    @Inject(FINANCE_CUSTOMER_LEDGER_CONTRACT) private readonly customerLedger: FinanceCustomerLedgerContract,
    @Inject(FINANCE_INVOICE_CONTRACT) private readonly invoices: FinanceInvoiceContract,
  ) {}

  async submitDeposit(
    salesOrderId: string,
    amount: string,
    method: string,
    reference: string | null,
    evidenceMediaAssetId: string | null,
    submittedByUserId: string,
    manager?: EntityManager,
  ): Promise<Deposit> {
    // Security Assurance Gate — Track S4 (Business Logic / Sequencing
    // Abuse), found 2026-09-08: unlike every other financial write path
    // in this codebase (PaymentsService.recordPayment, Treasury's
    // cashIn/cashOut/transfer — all validate `amount > 0`), this method
    // had NO positivity check at all — the DTO's `@IsNumberString()`
    // accepts "-999999.00" or "0.00" just as happily as "50.00". If a
    // negative-amount deposit were later approved, `createDepositTransaction`
    // (also fixed, see its own comment) would have posted a NEGATIVE
    // Treasury cash-in (silently draining the account instead of
    // crediting it) and a NEGATIVE Customer Ledger credit (increasing,
    // not decreasing, what the customer appears to owe) — both disguised
    // as an ordinary "customer deposit" in the audit trail. Approval
    // still requires a human finance/manager action, but relying solely
    // on a reviewer noticing a negative sign in a form field is not a
    // real control, especially under volume.
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      throw new BadRequestException('Deposit amount must be a positive number.');
    }

    // V1 Release Audit MEDIUM fix — no scope check previously; reuses
    // SalesOrdersService.getOrder's existing check (reviewer roles pass,
    // otherwise Scope must include this order) rather than duplicating
    // it, which also confirms the order actually exists.
    await this.salesOrders.getOrder(salesOrderId, submittedByUserId, manager);

    const deposit = await (manager ?? this.dataSource).transaction(async (txManager) => {
      const repo = txManager.getRepository(Deposit);
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
      await this.events.publish(txManager, 'deposit.submitted', {
        depositId: saved.id,
        salesOrderId,
        amount,
        method,
      });
      return saved;
    });

    await this.audit.record(
      {
        actorUserId: submittedByUserId,
        organizationId: null,
        action: 'deposit.submitted',
        resource: 'deposit',
        resourceId: deposit.id,
        result: 'success',
        correlationId: null,
        after: { salesOrderId, amount, method },
      },
      manager,
    );

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
  /**
   * Security Assurance Gate — Track S5 (Concurrency/Race Condition), found
   * 2026-09-08: this method used to read the deposit, check its status,
   * then perform several cross-domain async calls (Treasury cash-in,
   * Customer Ledger credit, order release) before ever writing
   * `status: 'approved'` back — with NO lock held across that window. Two
   * concurrent `approveDeposit` calls on the SAME deposit (a double-click,
   * a retried request, or a deliberate race) could BOTH pass the status
   * check while it still read `'submitted'`, and BOTH would then post a
   * real Treasury cash-in + Customer Ledger credit for the same deposit —
   * a duplicate financial effect, exactly the class of bug the standing
   * "no race condition may permit duplicate financial effect" acceptance
   * criterion exists to catch. `pg_advisory_xact_lock`-style locks
   * elsewhere in this codebase (Treasury's own account-level lock,
   * unchanged below) protect ACCOUNT-level balance races, not THIS kind
   * of same-deposit double-processing — a different lock for a different
   * invariant, not a duplicate of an existing one.
   *
   * Fix: a Postgres row-level lock (`pessimistic_write`, i.e. `SELECT ...
   * FOR UPDATE`) on the deposit row itself, held for the full duration of
   * the approval — a second concurrent caller's own lock acquisition
   * blocks until the first transaction commits (by which point `status`
   * is already `'approved'`), so its own status re-check inside the lock
   * correctly rejects it instead of double-processing. Transaction-scoped
   * (releases automatically on commit/rollback) — no separate unlock call,
   * no session-persistence pitfall the way a bare `pg_advisory_lock`
   * (non-`_xact`) would have.
   */
  async approveDeposit(depositId: string, actorUserId: string, treasuryAccountId: string, manager?: EntityManager): Promise<Deposit> {
    const { saved, order, deposit } = await (manager ?? this.dataSource).transaction(async (txManager) => {
      const repo = txManager.getRepository(Deposit);
      const lockedDeposit = await repo.findOne({ where: { id: depositId }, lock: { mode: 'pessimistic_write' } });
      if (!lockedDeposit) throw new NotFoundException(`Deposit "${depositId}" not found.`);
      if (!canTransitionDepositStatus(lockedDeposit.status, 'approved')) {
        throw new ConflictException(`Cannot approve a deposit in status "${lockedDeposit.status}".`);
      }

      const resolvedOrder = await this.salesOrders.getOrder(lockedDeposit.salesOrderId, actorUserId, txManager);
      const orderStatus = await this.salesOrders.getOrderStatus(lockedDeposit.salesOrderId, txManager);
      if (orderStatus !== 'deposit_verification') {
        throw new ConflictException(`Cannot approve this deposit — order "${lockedDeposit.salesOrderId}" is in status "${orderStatus}", not awaiting deposit verification.`);
      }

      const treasuryTxn = await this.treasury.createDepositTransaction(
        depositId,
        lockedDeposit.salesOrderId,
        resolvedOrder.customerId,
        lockedDeposit.amount,
        treasuryAccountId,
        actorUserId,
        txManager,
      );

      // Customer Financial Account / AR (CTO directive) — the existing
      // Deposit/Treasury flow is reused as-is; this only ADDS the Customer
      // Ledger entry on top. If an invoice already exists for this order
      // and is posted (an edge case — deposits normally precede invoicing),
      // link directly; otherwise post unapplied and let `InvoiceService.
      // postInvoice`'s own sweep pick it up later.
      const existingInvoice = await this.invoices.findOpenInvoiceForOrder(lockedDeposit.salesOrderId, txManager);
      const existingInvoiceState = existingInvoice ? await this.invoices.getStatus(existingInvoice.id, txManager) : null;
      const linkedInvoiceId = existingInvoiceState === 'posted' || existingInvoiceState === 'partially_paid' ? existingInvoice!.id : null;

      await this.customerLedger.postEntry(
        {
          customerId: resolvedOrder.customerId,
          entryType: 'deposit',
          direction: 'credit',
          amount: lockedDeposit.amount,
          salesOrderId: lockedDeposit.salesOrderId,
          invoiceId: linkedInvoiceId,
          depositId,
          treasuryTransactionId: treasuryTxn.id,
          reference: depositId,
          reason: `Customer deposit (${lockedDeposit.method})`,
          createdByUserId: actorUserId,
        },
        txManager,
      );
      if (linkedInvoiceId) await this.invoices.recomputeStatus(linkedInvoiceId, actorUserId, txManager);

      lockedDeposit.status = 'approved';
      lockedDeposit.reviewedByUserId = actorUserId;
      const savedDeposit = await repo.save(lockedDeposit);
      return { saved: savedDeposit, order: resolvedOrder, deposit: lockedDeposit };
    });

    await this.salesOrders.releaseAfterDepositVerified(deposit.salesOrderId, actorUserId, manager);

    // F09-H1 (ADR-042 D0/D1/D9) — resolve the approver-chosen Treasury account's mapped GL code
    // via the EXISTING `getAllTreasuryBalances` read (no new contract method — ADR-042 D1). `null`
    // when unmapped; the event is still published (never silently skipped) so F09's handler can
    // reject with a specific, re-drivable reason rather than leaving no trail at all.
    const { balances } = await this.treasury.getAllTreasuryBalances(undefined, manager);
    const glAccountCode = balances.find((b) => b.treasuryAccountId === treasuryAccountId)?.glAccountCode ?? null;

    await (manager ?? this.dataSource).transaction(async (txManager) => {
      await this.events.publish(txManager, 'deposit.verified', {
        // ADR-042 D0 — publisher-built, from this deposit's own real, stable, unique row id.
        // Fixes RBW Gap 1: the previous payload had no field ingest()'s idempotency-key derivation
        // recognized, so every occurrence collided on the SAME derived key.
        idempotencyKey: `deposit:${saved.id}:verified`,
        depositId: saved.id,
        salesOrderId: deposit.salesOrderId,
        customerId: order.customerId,
        amount: deposit.amount,
        currency: CURRENCY,
        method: deposit.method,
        reference: deposit.reference,
        verifiedByUserId: actorUserId,
        businessDate: new Date().toISOString(),
        // ADR-042 D1 — the GL-account reference F09's handler needs; resolved by THIS publisher,
        // never by the handler re-deriving it.
        glAccountCode,
      });
    });
    // F09-H1 (RBW Gap 2) — every other financial-event publisher in this codebase calls this
    // immediately after publish(); `deposit.verified` previously did not.
    await this.events.dispatchAfterCommit(manager);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'deposit.verified',
        resource: 'deposit',
        resourceId: depositId,
        result: 'success',
        correlationId: null,
        after: { status: 'approved', salesOrderId: deposit.salesOrderId },
      },
      manager,
    );

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
  async rejectDeposit(depositId: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<Deposit> {
    const repo = (manager ?? this.dataSource).getRepository(Deposit);
    const deposit = await repo.findOne({ where: { id: depositId } });
    if (!deposit) throw new NotFoundException(`Deposit "${depositId}" not found.`);
    await this.salesOrders.getOrder(deposit.salesOrderId, actorUserId, manager); // AUDIT-SEC-03 remediation: its sibling approveDeposit already had this check — rejectDeposit didn't, a write-path gap
    if (!canTransitionDepositStatus(deposit.status, 'rejected')) {
      throw new ConflictException(`Cannot reject a deposit in status "${deposit.status}".`);
    }

    deposit.status = 'rejected';
    deposit.reviewedByUserId = actorUserId;
    deposit.rejectionReason = reason;
    const saved = await repo.save(deposit);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'deposit.rejected',
        resource: 'deposit',
        resourceId: depositId,
        result: 'success',
        correlationId: null,
        after: { status: 'rejected', salesOrderId: deposit.salesOrderId, reason },
      },
      manager,
    );

    return saved;
  }

  /** V1 Release Audit MEDIUM fix (IDOR) — exposed payment amount/method/reference/evidence for any order to any authenticated user. */
  async getDeposit(depositId: string, requestingUserId: string, manager?: EntityManager): Promise<Deposit> {
    const deposit = await (manager ?? this.dataSource).getRepository(Deposit).findOne({ where: { id: depositId } });
    if (!deposit) throw new NotFoundException(`Deposit "${depositId}" not found.`);
    await this.salesOrders.getOrder(deposit.salesOrderId, requestingUserId, manager);
    return deposit;
  }

  /** Backs the Sales Order detail screen's deposit panel — most recent deposit for an order, or null before one is ever submitted. V1 Release Audit MEDIUM fix (IDOR): same missing check as getDeposit. */
  async getLatestDepositForOrder(salesOrderId: string, requestingUserId: string, manager?: EntityManager): Promise<Deposit | null> {
    await this.salesOrders.getOrder(salesOrderId, requestingUserId, manager);
    return (manager ?? this.dataSource)
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
  async listDepositsForOrder(salesOrderId: string, requestingUserId: string, manager?: EntityManager): Promise<Deposit[]> {
    await this.salesOrders.getOrder(salesOrderId, requestingUserId, manager);
    return (manager ?? this.dataSource).getRepository(Deposit).find({ where: { salesOrderId }, order: { createdAt: 'ASC' } });
  }
}
