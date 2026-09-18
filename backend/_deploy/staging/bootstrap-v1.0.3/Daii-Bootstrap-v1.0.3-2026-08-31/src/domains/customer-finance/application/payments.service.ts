import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Payment } from '../infrastructure/payment.entity';
import { SalesInvoice } from '../infrastructure/sales-invoice.entity';
import { CustomerLedgerService } from './customer-ledger.service';
import { InvoiceService } from './invoices.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { CustomersService } from '../../crm/application/customers.service';

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
    private readonly customers: CustomersService,
  ) {}

  async recordPayment(
    customerId: string,
    invoiceId: string,
    amount: string,
    method: string,
    treasuryAccountId: string,
    reference: string | null,
    actorUserId: string,
  ): Promise<Payment> {
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      throw new BadRequestException('Payment amount must be a positive number.');
    }

    const invoice = await this.dataSource.getRepository(SalesInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    if (invoice.customerId !== customerId) {
      throw new ForbiddenException('This invoice belongs to a different customer.');
    }

    const remaining = Number(await this.invoices.getInvoiceRemaining(invoiceId));
    if (Number(amount) > remaining) {
      throw new ConflictException(`Cannot record ${amount} — only ${remaining.toFixed(2)} remains on invoice "${invoice.invoiceNumber}".`);
    }

    const treasuryTxn = await this.treasury.cashIn(treasuryAccountId, amount, customerId, invoice.salesOrderId, invoiceId, 'customer_payment', actorUserId);

    await this.numbering.registerDocumentType(PAYMENT_DOCUMENT_TYPE, PAYMENT_PREFIX); // idempotent
    const paymentNumber = await this.numbering.getNextNumber(PAYMENT_DOCUMENT_TYPE);

    const repo = this.dataSource.getRepository(Payment);
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

    await this.ledger.postEntry({
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
    });

    await this.invoices.recomputeStatus(invoiceId, actorUserId);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'customer_finance.payment.recorded',
      resource: 'customer_payment',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { customerId, invoiceId, amount, method, treasuryAccountId, treasuryTransactionId: treasuryTxn.id },
    });

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
