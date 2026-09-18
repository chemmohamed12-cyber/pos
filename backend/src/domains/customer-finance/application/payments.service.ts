import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { Payment } from '../infrastructure/payment.entity';
import { SalesInvoice } from '../infrastructure/sales-invoice.entity';
import { CustomerLedgerService } from './customer-ledger.service';
import { InvoiceService } from './invoices.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { SALES_CUSTOMERS_CONTRACT, SalesCustomersContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { AR_EVENT_TOPICS } from '../../../foundation/module-registry/contracts/ar-events.contract';

const PAYMENT_DOCUMENT_TYPE = 'customer_payment';
const PAYMENT_PREFIX = 'PAY';

/**
 * Customer Financial Account / AR (CTO directive) — Customer → Payment →
 * Customer Account → Treasury. Never mutates a balance directly: posts
 * one Treasury `cash_in` (the SAME `TreasuryService` every other cash
 * inflow in this codebase already uses) then one Customer Ledger
 * `payment` credit entry, then lets `InvoiceService.recomputeStatus`
 * decide whether the invoice is now `partially_paid` or `paid`.
 * Overpayment is rejected outright (disclosed V1 simplification — a
 * "credit on account" concept for an overpayment is future work).
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly treasury: TreasuryService,
    private readonly ledger: CustomerLedgerService,
    private readonly invoices: InvoiceService,
    private readonly events: EventBusService,
    @Inject(SALES_CUSTOMERS_CONTRACT) private readonly customers: SalesCustomersContract,
  ) {}

  /**
   * Gap Resolution Package 3 (2026-09-14, Amendment-accepted `02_APPROVED_BLUEPRINT.md`) —
   * every write below now shares ONE transaction/`EntityManager`, closing rows 18/33/34: previously
   * the Treasury cash-in, the payment-number draw, the `Payment` row insert, the AR credit entry,
   * and the invoice-status recompute each committed independently, so a crash partway left a real
   * cash movement with no corresponding Payment/AR record. A `pg_advisory_xact_lock` keyed on the
   * invoice (same primitive `TreasuryService.cashInCore`/`postTransaction` already use, just keyed
   * differently) serializes two concurrent payments against the SAME invoice, closing the
   * "two individually-valid partial payments jointly overpay" race the required concurrent-execution
   * test in the Blueprint calls out — `getInvoiceRemaining` is read fresh, under the lock, from
   * inside this same transaction, not a value read before it.
   *
   * `manager` is optional (Mandatory Implementation Invariant, Blueprint P3 §7): when the caller
   * (e.g. `PaymentsController` via `IdempotencyService.withIdempotencyInTransaction`) already owns a
   * transaction, this method joins it and never opens its own — when called with no manager (every
   * existing test, and any other future caller), it opens exactly one transaction itself, byte-for-byte
   * the same shape the previous implementation's tests already assert.
   */
  async recordPayment(
    customerId: string,
    invoiceId: string,
    amount: string,
    method: string,
    treasuryAccountId: string,
    reference: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<Payment> {
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      throw new BadRequestException('Payment amount must be a positive number.');
    }
    await this.customers.getCustomer(customerId, actorUserId); // AUDIT-SEC-03 remediation: was a raw write with no Scope check — any finance.payment.create holder could record a payment against any customer's invoice

    const run = async (m: EntityManager): Promise<Payment> => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payment:invoice:${invoiceId}`]);

      const invoice = await m.getRepository(SalesInvoice).findOne({ where: { id: invoiceId } });
      if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
      if (invoice.customerId !== customerId) {
        throw new ForbiddenException('This invoice belongs to a different customer.');
      }

      const remaining = Number(await this.invoices.getInvoiceRemaining(invoiceId, m));
      if (Number(amount) > remaining) {
        throw new ConflictException(`Cannot record ${amount} — only ${remaining.toFixed(2)} remains on invoice "${invoice.invoiceNumber}".`);
      }

      const treasuryTxn = await this.treasury.cashIn(treasuryAccountId, amount, customerId, invoice.salesOrderId, invoiceId, 'customer_payment', actorUserId, m);

      await this.numbering.registerDocumentType(PAYMENT_DOCUMENT_TYPE, PAYMENT_PREFIX); // idempotent; not manager-threaded (see NumberingService — negligible, first-call-only write)
      const paymentNumber = await this.numbering.getNextNumber(PAYMENT_DOCUMENT_TYPE, m);

      const repo = m.getRepository(Payment);
      const saved = await repo.save(
        repo.create({
          paymentNumber,
          customerId,
          invoiceId,
          amount,
          method,
          treasuryAccountId,
          treasuryTransactionId: treasuryTxn.id,
          reference,
          recordedByUserId: actorUserId,
        }),
      );

      await this.ledger.postEntry(
        {
          customerId,
          entryType: 'payment',
          direction: 'credit',
          amount,
          salesOrderId: invoice.salesOrderId,
          invoiceId,
          paymentId: saved.id,
          treasuryTransactionId: treasuryTxn.id,
          reference: paymentNumber,
          reason: `Payment (${method})`,
          createdByUserId: actorUserId,
        },
        m,
      );
      await this.events.publish(m, AR_EVENT_TOPICS.paymentRecorded, {
        idempotencyKey: `customer-finance:payment:${saved.id}:recorded`,
        businessDate: new Date().toISOString().slice(0, 10),
        orgUnitId: null,
        currency: 'EGP',
        sourceEntityType: 'payment' as const,
        sourceEntityId: saved.id,
        externalDocument: null,
        payloadVersion: 1,
        paymentId: saved.id,
        paymentNumber,
        customerId,
        invoiceId,
        amount,
        method,
        treasuryAccountId,
      });

      await this.invoices.recomputeStatus(invoiceId, actorUserId, m);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'customer_finance.payment.recorded',
          resource: 'customer_payment',
          resourceId: saved.id,
          result: 'success',
          correlationId: null,
          after: { customerId, invoiceId, amount, method, treasuryAccountId, treasuryTransactionId: treasuryTxn.id },
        },
        m,
      );

      return saved;
    };

    const saved = manager ? await run(manager) : await this.dataSource.transaction(run);
    // Same "who dispatches" convention as `TreasuryService.cashInCore`: only the call that owns the
    // transaction (no manager supplied) dispatches — a caller-supplied manager means the CALLER
    // decides when to dispatch, since only it knows when its own outer transaction actually commits.
    if (!manager) await this.events.dispatchPending();
    return saved;
  }

  async listPaymentsForCustomer(customerId: string): Promise<Payment[]> {
    return this.dataSource.getRepository(Payment).find({ where: { customerId }, order: { occurredAt: 'DESC' } });
  }

  /** ERP UI Integration (CTO directive) — the "التحصيلات والمدفوعات" list screen, across every customer the caller may see. Scope-filtered via `CustomersService.listCustomers`, same discipline as `InvoiceService.listAllInvoices`. */
  async listAllPayments(actorUserId: string): Promise<Array<Payment & { customerCode: string; customerName: string; invoiceNumber: string | null }>> {
    const customers = await this.customers.listCustomers(actorUserId);
    const customerById = new Map(customers.map((c) => [c.id, c]));
    if (customerById.size === 0) return [];

    const payments = await this.dataSource
      .getRepository(Payment)
      .find({ where: { customerId: In([...customerById.keys()]) }, order: { occurredAt: 'DESC' } });
    if (payments.length === 0) return [];

    const invoiceIds = [...new Set(payments.map((p) => p.invoiceId))];
    const invoices = await this.dataSource.getRepository(SalesInvoice).find({ where: { id: In(invoiceIds) } });
    const invoiceNumberById = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));

    return payments.map((p) => ({
      ...p,
      customerCode: customerById.get(p.customerId)?.code ?? '',
      customerName: customerById.get(p.customerId)?.name ?? '',
      invoiceNumber: invoiceNumberById.get(p.invoiceId) ?? null,
    }));
  }
}
