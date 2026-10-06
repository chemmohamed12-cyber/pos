import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { SupplierPayment } from '../infrastructure/supplier-payment.entity';
import { SupplierInvoice } from '../infrastructure/supplier-invoice.entity';
import { Supplier } from '../infrastructure/supplier.entity';
import { SupplierLedgerService } from './supplier-ledger.service';
import { SupplierInvoiceService } from './supplier-invoice.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { FinanceTreasuryContract, FINANCE_TREASURY_CONTRACT } from '../../../foundation/module-registry/contracts/finance.contract';
import { AP_EVENT_TOPICS } from '../../../foundation/module-registry/contracts/ap-events.contract';

const PAYMENT_DOCUMENT_TYPE = 'supplier_payment';
const PAYMENT_PREFIX = 'SPAY';

/**
 * ADR-048 — Supplier → Payment → Supplier Ledger → Treasury, the exact
 * mirror of `PaymentsService` (customer-finance) for the payable side.
 * Posts one Treasury `cash_out` then one Supplier Ledger `payment` debit
 * entry, all in ONE transaction, then lets
 * `SupplierInvoiceService.recomputeStatus` decide whether the invoice is
 * now `partially_paid` or `paid`. Overpayment is rejected outright — same
 * disclosed V1 simplification as the customer side.
 *
 * P0 correction (OP-Procurement/AP Blueprint §8, CTO ratification
 * Decision 1: APPROVED — Option A, applied 2026-09-18) — reaches Treasury
 * through `FINANCE_TREASURY_CONTRACT`'s `cashOutForSupplier`, not a raw
 * import of the concrete `TreasuryService` (this domain's original
 * construction imported it directly; the blueprint's own Foundation Law
 * table names this exact pattern as the one to avoid). Atomicity —
 * Treasury leg + `Payment` row + Supplier Ledger debit committing or
 * rolling back together — is unaffected: the contract method carries the
 * same additive `manager?` `cashOut`/`cashOutForSupplier` already share.
 */
@Injectable()
export class SupplierPaymentService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    @Inject(FINANCE_TREASURY_CONTRACT) private readonly treasury: FinanceTreasuryContract,
    private readonly ledger: SupplierLedgerService,
    private readonly invoices: SupplierInvoiceService,
    private readonly events: EventBusService,
  ) {}

  async recordPayment(
    supplierId: string,
    invoiceId: string,
    amount: string,
    method: string,
    treasuryAccountId: string,
    reference: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<SupplierPayment> {
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      throw new BadRequestException('Payment amount must be a positive number.');
    }

    const saved = await (manager ?? this.dataSource).transaction(async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supplier_payment:invoice:${invoiceId}`]);

      const invoice = await m.getRepository(SupplierInvoice).findOne({ where: { id: invoiceId } });
      if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
      if (invoice.supplierId !== supplierId) {
        throw new ConflictException('This invoice belongs to a different supplier.');
      }

      const remaining = Number(await this.invoices.getInvoiceRemaining(invoiceId, m));
      if (Number(amount) > remaining) {
        throw new ConflictException(`Cannot record ${amount} — only ${remaining.toFixed(2)} remains on invoice "${invoice.invoiceNumber}".`);
      }

      // D2: reject an unmapped paying account BEFORE any treasury/ledger mutation; the mapped GL code travels in the event.
      const { glAccountCode } = await this.treasury.requireGlMappedAccount(treasuryAccountId, m);

      const treasuryTxn = await this.treasury.cashOutForSupplier(treasuryAccountId, amount, supplierId, invoiceId, invoice.invoiceNumber, 'supplier_payment', actorUserId, m);

      await this.numbering.registerDocumentType(PAYMENT_DOCUMENT_TYPE, PAYMENT_PREFIX, true, m);
      const paymentNumber = await this.numbering.getNextNumber(PAYMENT_DOCUMENT_TYPE, m);

      const repo = m.getRepository(SupplierPayment);
      const savedPayment = await repo.save(
        repo.create({
          paymentNumber,
          supplierId,
          supplierInvoiceId: invoiceId,
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
          supplierId,
          entryType: 'payment',
          direction: 'debit',
          amount,
          purchaseOrderId: invoice.purchaseOrderId,
          supplierInvoiceId: invoiceId,
          supplierPaymentId: savedPayment.id,
          treasuryTransactionId: treasuryTxn.id,
          reference: paymentNumber,
          reason: `Payment (${method})`,
          createdByUserId: actorUserId,
        },
        m,
      );

      await this.events.publish(m, AP_EVENT_TOPICS.supplierPaymentRecorded, {
        idempotencyKey: `procurement:supplier_payment:${savedPayment.id}:recorded`,
        businessDate: new Date().toISOString().slice(0, 10),
        orgUnitId: null,
        currency: 'EGP',
        sourceEntityType: 'supplier_payment' as const,
        sourceEntityId: savedPayment.id,
        externalDocument: null,
        payloadVersion: 1,
        supplierPaymentId: savedPayment.id,
        paymentNumber,
        supplierId,
        supplierInvoiceId: invoiceId,
        amount,
        method,
        treasuryAccountId,
        glAccountCode,
      });

      await this.invoices.recomputeStatus(invoiceId, actorUserId, m);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'procurement.supplier_payment.recorded',
          resource: 'supplier_payment',
          resourceId: savedPayment.id,
          result: 'success',
          correlationId: null,
          after: { supplierId, invoiceId, amount, method, treasuryAccountId, treasuryTransactionId: treasuryTxn.id },
        },
        m,
      );

      return savedPayment;
    });

    await this.events.dispatchAfterCommit(manager);
    return saved;
  }

  async listForSupplier(supplierId: string, manager?: EntityManager): Promise<SupplierPayment[]> {
    return (manager ?? this.dataSource).getRepository(SupplierPayment).find({ where: { supplierId }, order: { occurredAt: 'DESC' } });
  }

  async listAll(manager?: EntityManager): Promise<Array<SupplierPayment & { supplierCode: string; supplierLegalName: string; invoiceNumber: string | null }>> {
    const payments = await (manager ?? this.dataSource).getRepository(SupplierPayment).find({ order: { occurredAt: 'DESC' } });
    if (payments.length === 0) return [];

    const supplierIds = [...new Set(payments.map((p) => p.supplierId))];
    const invoiceIds = [...new Set(payments.map((p) => p.supplierInvoiceId))];
    const [suppliers, invoices] = await Promise.all([
      (manager ?? this.dataSource).getRepository(Supplier).find({ where: { id: In(supplierIds) } }),
      (manager ?? this.dataSource).getRepository(SupplierInvoice).find({ where: { id: In(invoiceIds) } }),
    ]);
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    const invoiceNumberById = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));

    return payments.map((p) => ({
      ...p,
      supplierCode: supplierById.get(p.supplierId)?.code ?? '',
      supplierLegalName: supplierById.get(p.supplierId)?.legalName ?? '',
      invoiceNumber: invoiceNumberById.get(p.supplierInvoiceId) ?? null,
    }));
  }
}
