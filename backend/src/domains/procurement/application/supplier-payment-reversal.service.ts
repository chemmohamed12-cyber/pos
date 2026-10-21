import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { SupplierPayment } from '../infrastructure/supplier-payment.entity';
import { SupplierLedgerService } from './supplier-ledger.service';
import { SupplierInvoiceService } from './supplier-invoice.service';
import { SUPPLIER_INVOICE_PROCESS } from '../domain/supplier-invoice-process';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { FinanceTreasuryContract, FINANCE_TREASURY_CONTRACT } from '../../../foundation/module-registry/contracts/finance.contract';
import { AP_EVENT_TOPICS } from '../../../foundation/module-registry/contracts/ap-events.contract';
import { runInTransaction } from '../../../foundation/transaction/run-in-transaction';

const REVERSAL_DOCUMENT_TYPE = 'supplier_payment_reversal';
const REVERSAL_PREFIX = 'SPREV';
const ENTITY_TYPE = 'supplier_invoice';

/**
 * T2-S (2026-10-21) — reversal of a SUPPLIER payment through its owning document: the payable-side mirror of `PaymentsService.reversePayment`. In ONE transaction it
 * (1) appends the offsetting Treasury leg (owner-driven, `cash_out` -> `cash_in`), (2) writes the one-per-payment reversal record (UNIQUE), (3) appends a Supplier Ledger
 * `payment_reversal` CREDIT per invoice bucket (AP up again — the original `payment` debits are never touched), (4) publishes `finance.supplier_payment.reversed`
 * (Dr bank / Cr AP, the exact mirror of `...recorded`), (5) re-opens every touched invoice (`paid -> partially_paid | posted`, `partially_paid -> posted`) so the status agrees
 * with the derived balance, (6) audits. Rejected BEFORE any mutation: missing reason, unknown payment, already reversed, no Treasury movement, a ledger that does not add up
 * to the payment, a voided invoice, an unmapped paying account. The allocation rows are history and stay as they are.
 */
@Injectable()
export class SupplierPaymentReversalService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly ledger: SupplierLedgerService,
    private readonly invoices: SupplierInvoiceService,
    private readonly processEngine: ProcessEngineService,
    private readonly events: EventBusService,
    @Inject(FINANCE_TREASURY_CONTRACT) private readonly treasury: FinanceTreasuryContract,
  ) {}

  async reversePayment(
    paymentId: string,
    reason: string,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<{ reversalId: string; reversalNumber: string; paymentId: string; amount: string; invoicesReopened: string[] }> {
    const why = (reason ?? '').trim();
    if (why.length < 3) throw new BadRequestException('A reason is required to reverse a supplier payment.');
    const run = async (m: EntityManager) => {
      const payment = await m.getRepository(SupplierPayment).findOne({ where: { id: paymentId } });
      if (!payment) throw new NotFoundException(`Supplier payment "${paymentId}" not found.`);
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supplier_payment:reverse:${paymentId}`]);

      const already: Array<{ reversalNumber: string }> = await m.query(`SELECT "reversalNumber" FROM "supplier_payment_reversals" WHERE "supplierPaymentId" = $1`, [paymentId]);
      if (already.length > 0) throw new ConflictException(`Supplier payment "${payment.paymentNumber}" was already reversed (${already[0].reversalNumber}).`);
      if (!payment.treasuryTransactionId) throw new ConflictException(`Supplier payment "${payment.paymentNumber}" has no Treasury movement to reverse.`);

      // where the payment's debit(s) currently sit in the Supplier Ledger (net debit per invoice)
      const buckets: Array<{ supplierInvoiceId: string | null; purchaseOrderId: string | null; net: string }> = await m.query(
        `SELECT "supplierInvoiceId", "purchaseOrderId", SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END)::text AS net
           FROM "supplier_ledger_entries" WHERE "supplierPaymentId" = $1 AND "status" = 'posted'
          GROUP BY "supplierInvoiceId", "purchaseOrderId"
         HAVING SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END) <> 0
          ORDER BY "supplierInvoiceId" NULLS FIRST`,
        [paymentId],
      );
      const total = buckets.reduce((a, b) => a + Number(b.net), 0);
      if (buckets.some((b) => Number(b.net) < 0) || Math.abs(total - Number(payment.amount)) > 0.004) {
        throw new ConflictException(`The Supplier Ledger for payment "${payment.paymentNumber}" does not add up to its amount (${payment.amount}) — it cannot be reversed automatically. Nothing was changed.`);
      }
      const invoiceIds = [...new Set(buckets.map((b) => b.supplierInvoiceId).filter((id): id is string => !!id))].sort();
      for (const id of invoiceIds) {
        await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supplier_payment:invoice:${id}`]);
        const state = await this.invoices.getStatus(id, m);
        if (state === 'void') throw new ConflictException(`Invoice ${id} is void — the payment cannot be reversed against it. Nothing was changed.`);
      }

      const { glAccountCode } = await this.treasury.requireGlMappedAccount(payment.treasuryAccountId, m);
      const reversalLeg = await this.treasury.reverseOwnedLeg(payment.treasuryTransactionId, `supplier payment ${payment.paymentNumber}: ${why}`, actorUserId, m);

      await this.numbering.registerDocumentType(REVERSAL_DOCUMENT_TYPE, REVERSAL_PREFIX, true, m);
      const reversalNumber = await this.numbering.getNextNumber(REVERSAL_DOCUMENT_TYPE, m);
      // plain SQL on purpose: the table is an append-only record owned by this service, so no entity has to be registered in the Company connection's entity list
      const saved: Array<{ id: string }> = await m.query(
        `INSERT INTO "supplier_payment_reversals" ("reversalNumber","supplierPaymentId","reason","reversedByUserId","treasuryReversalTransactionId","amount") VALUES ($1,$2,$3,$4,$5,$6) RETURNING "id"`,
        [reversalNumber, paymentId, why, actorUserId, reversalLeg.id, payment.amount],
      );
      const reversal = saved[0];

      for (const b of buckets) {
        await this.ledger.postEntry(
          {
            supplierId: payment.supplierId,
            entryType: 'payment_reversal',
            direction: 'credit',
            amount: Number(b.net).toFixed(2),
            purchaseOrderId: b.purchaseOrderId,
            supplierInvoiceId: b.supplierInvoiceId,
            supplierPaymentId: paymentId,
            treasuryTransactionId: reversalLeg.id,
            reference: reversalNumber,
            reason: `Reversal of supplier payment ${payment.paymentNumber}: ${why}`,
            createdByUserId: actorUserId,
          },
          m,
        );
      }

      await this.events.publish(m, AP_EVENT_TOPICS.supplierPaymentReversed, {
        idempotencyKey: `procurement:supplier_payment:${paymentId}:reversed`,
        businessDate: new Date().toISOString().slice(0, 10),
        orgUnitId: null,
        currency: 'EGP',
        sourceEntityType: 'supplier_payment' as const,
        sourceEntityId: paymentId,
        externalDocument: null,
        payloadVersion: 1,
        supplierPaymentId: paymentId,
        paymentNumber: payment.paymentNumber,
        reversalNumber,
        supplierId: payment.supplierId,
        amount: payment.amount,
        treasuryAccountId: payment.treasuryAccountId,
        glAccountCode,
        reversalOf: paymentId,
        reason: why,
      });

      for (const id of invoiceIds) await this.resyncStatusAfterReversal(id, actorUserId, m);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'procurement.supplier_payment.reversed',
          resource: 'supplier_payment',
          resourceId: paymentId,
          result: 'success',
          correlationId: reversal.id,
          after: { reversalNumber, amount: payment.amount, reason: why, treasuryReversalTransactionId: reversalLeg.id, invoices: invoiceIds },
        },
        m,
      );
      return { reversalId: reversal.id, reversalNumber, paymentId, amount: payment.amount, invoicesReopened: invoiceIds };
    };
    const result = await runInTransaction(this.dataSource, manager, run);
    await this.events.dispatchAfterCommit(manager);
    return result;
  }

  /**
   * After a reversal the invoice's balance rose again: `paid -> partially_paid` while some payment still stands, `paid | partially_paid -> posted` when no payment (net of its
   * reversals) stands any more. Idempotent; a posted / void / draft invoice is untouched. The status is always derived from the Supplier Ledger, never set by a client.
   */
  private async resyncStatusAfterReversal(invoiceId: string, actorUserId: string, m: EntityManager): Promise<string> {
    const state = await this.invoices.getStatus(invoiceId, m);
    if (state !== 'paid' && state !== 'partially_paid') return state;
    const net: Array<{ n: string }> = await m.query(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END), 0)::text AS n
         FROM "supplier_ledger_entries" WHERE "supplierInvoiceId" = $1 AND "entryType" IN ('payment', 'payment_reversal') AND "status" = 'posted'`,
      [invoiceId],
    );
    const stillPaid = Number(net[0]?.n ?? '0');
    const remaining = Number(await this.invoices.getInvoiceRemaining(invoiceId, m));
    if (stillPaid <= 0) {
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'reopen_paid', actorUserId, m);
    } else if (state === 'paid' && remaining > 0) {
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'reopen_partial', actorUserId, m);
    }
    return this.invoices.getStatus(invoiceId, m);
  }
}
