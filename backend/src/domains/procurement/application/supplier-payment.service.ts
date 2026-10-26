import { purchaseOrderBranchOf, treasuryAccountBranchOf } from './procurement-org';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { SupplierPayment } from '../infrastructure/supplier-payment.entity';
import { SupplierInvoice } from '../infrastructure/supplier-invoice.entity';
import { SupplierPaymentAllocation } from '../infrastructure/supplier-payment-allocation.entity';
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

  /** Single-invoice payment - unchanged public contract; now also writes its one allocation row. */
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
    return this.recordInternal(supplierId, [{ invoiceId, amount }], method, treasuryAccountId, reference, actorUserId, false, manager);
  }

  /**
   * Phase B (CTO-approved 2026-10-20) - ONE payment settling SEVERAL supplier invoices of the same supplier. Exactly one Treasury cash-out (the total), one payment row, one financial event
   * (Dr AP / Cr Bank for the total), and one Supplier Ledger payment debit PER invoice, all in one transaction. Each allocation may not exceed that invoice's outstanding balance; the invoices
   * must be live (posted / partially paid). The payment's `supplierInvoiceId` keeps the first allocation's invoice so older screens and reports still work.
   */
  async recordPaymentAllocated(
    supplierId: string,
    allocations: Array<{ invoiceId: string; amount: string }>,
    method: string,
    treasuryAccountId: string,
    reference: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<SupplierPayment & { allocations: SupplierPaymentAllocation[] }> {
    if (allocations.length === 0) throw new BadRequestException('A payment needs at least one invoice allocation.');
    const ids = allocations.map((a) => a.invoiceId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('An invoice can appear only once in a payment allocation.');
    for (const a of allocations) {
      if (!Number.isFinite(Number(a.amount)) || Number(a.amount) <= 0) throw new BadRequestException('Every allocated amount must be a positive number.');
    }
    const payment = await this.recordInternal(supplierId, allocations, method, treasuryAccountId, reference, actorUserId, true, manager);
    const rows = await (manager ?? this.dataSource).getRepository(SupplierPaymentAllocation).find({ where: { supplierPaymentId: payment.id } });
    return Object.assign(payment, { allocations: rows });
  }

  private async recordInternal(
    supplierId: string,
    allocations: Array<{ invoiceId: string; amount: string }>,
    method: string,
    treasuryAccountId: string,
    reference: string | null,
    actorUserId: string,
    strictState: boolean,
    manager?: EntityManager,
  ): Promise<SupplierPayment> {
    // money in whole piastres so the allocation total is exact
    const cents = allocations.map((a) => Math.round(Number(a.amount) * 100));
    const totalCents = cents.reduce((s, c) => s + c, 0);
    const amount = (totalCents / 100).toFixed(2);
    const single = allocations.length === 1;

    const saved = await (manager ?? this.dataSource).transaction(async (m) => {
      // serialise per invoice, in a fixed order (no deadlock between two multi-invoice payments); same key as the single-invoice path
      for (const id of [...allocations.map((a) => a.invoiceId)].sort()) {
        await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supplier_payment:invoice:${id}`]);
      }

      const invoices: SupplierInvoice[] = [];
      for (let i = 0; i < allocations.length; i++) {
        const invoiceId = allocations[i].invoiceId;
        const invoice = await m.getRepository(SupplierInvoice).findOne({ where: { id: invoiceId } });
        if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
        if (invoice.supplierId !== supplierId) {
          throw new ConflictException('This invoice belongs to a different supplier.');
        }
        if (strictState) {
          const state = await this.invoices.getStatus(invoiceId, m);
          if (state !== 'posted' && state !== 'partially_paid') {
            throw new ConflictException(`Invoice "${invoice.invoiceNumber}" is "${state}" - only a posted or partially paid invoice can be paid.`);
          }
        }
        const remaining = Number(await this.invoices.getInvoiceRemaining(invoiceId, m));
        if (cents[i] / 100 > remaining) {
          throw new ConflictException(`Cannot record ${(cents[i] / 100).toFixed(2)} — only ${remaining.toFixed(2)} remains on invoice "${invoice.invoiceNumber}".`);
        }
        invoices.push(invoice);
      }

      // D2: reject an unmapped paying account BEFORE any treasury/ledger mutation; the mapped GL code travels in the event.
      const { glAccountCode } = await this.treasury.requireGlMappedAccount(treasuryAccountId, m);

      // Org engine WP-A (D-A option B): each allocation carries its invoice's branch (the PO's branch); the bank leg carries the paying account's branch.
      const bankOrgUnitId = await treasuryAccountBranchOf(m, treasuryAccountId);
      const allocationUnits: Array<string | null> = [];
      for (const inv of invoices) allocationUnits.push(await purchaseOrderBranchOf(m, inv.purchaseOrderId));

      const treasuryTxn = await this.treasury.cashOutForSupplier(
        treasuryAccountId,
        amount,
        supplierId,
        single ? invoices[0].id : null,
        single ? invoices[0].invoiceNumber : invoices.map((i) => i.invoiceNumber).join(', ').slice(0, 250),
        'supplier_payment',
        actorUserId,
        m,
      );

      await this.numbering.registerDocumentType(PAYMENT_DOCUMENT_TYPE, PAYMENT_PREFIX, true, m);
      const paymentNumber = await this.numbering.getNextNumber(PAYMENT_DOCUMENT_TYPE, m);

      const repo = m.getRepository(SupplierPayment);
      const savedPayment = await repo.save(
        repo.create({
          paymentNumber,
          supplierId,
          supplierInvoiceId: invoices[0].id,
          amount,
          method,
          treasuryAccountId,
          treasuryTransactionId: treasuryTxn.id,
          reference,
          recordedByUserId: actorUserId,
          bankOrgUnitId,
        }),
      );

      const allocRepo = m.getRepository(SupplierPaymentAllocation);
      for (let i = 0; i < invoices.length; i++) {
        const part = (cents[i] / 100).toFixed(2);
        await allocRepo.save(allocRepo.create({ supplierPaymentId: savedPayment.id, supplierInvoiceId: invoices[i].id, amount: part, orgUnitId: allocationUnits[i] }));
        await this.ledger.postEntry(
          {
            supplierId,
            entryType: 'payment',
            direction: 'debit',
            amount: part,
            purchaseOrderId: invoices[i].purchaseOrderId,
            supplierInvoiceId: invoices[i].id,
            supplierPaymentId: savedPayment.id,
            treasuryTransactionId: treasuryTxn.id,
            reference: paymentNumber,
            reason: `Payment (${method})`,
            createdByUserId: actorUserId,
          },
          m,
        );
      }

      await this.events.publish(m, AP_EVENT_TOPICS.supplierPaymentRecorded, {
        idempotencyKey: `procurement:supplier_payment:${savedPayment.id}:recorded`,
        businessDate: new Date().toISOString().slice(0, 10),
        orgUnitId: null, // the entry is attributed per LINE (allocations below), not as a whole
        currency: 'EGP',
        sourceEntityType: 'supplier_payment' as const,
        sourceEntityId: savedPayment.id,
        externalDocument: null,
        payloadVersion: 2,
        supplierPaymentId: savedPayment.id,
        paymentNumber,
        supplierId,
        supplierInvoiceId: invoices[0].id,
        amount,
        method,
        treasuryAccountId,
        glAccountCode,
        bankOrgUnitId,
        allocations: invoices.map((inv, i) => ({ invoiceId: inv.id, amount: (cents[i] / 100).toFixed(2), orgUnitId: allocationUnits[i] })),
      });

      for (const inv of invoices) await this.invoices.recomputeStatus(inv.id, actorUserId, m);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'procurement.supplier_payment.recorded',
          resource: 'supplier_payment',
          resourceId: savedPayment.id,
          result: 'success',
          correlationId: null,
          after: {
            supplierId,
            invoiceId: invoices[0].id,
            amount,
            method,
            treasuryAccountId,
            treasuryTransactionId: treasuryTxn.id,
            allocations: invoices.map((inv, i) => ({ invoiceId: inv.id, amount: (cents[i] / 100).toFixed(2) })),
          },
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

  async listAll(
    manager?: EntityManager,
  ): Promise<Array<SupplierPayment & { supplierCode: string; supplierLegalName: string; invoiceNumber: string | null; allocations: Array<{ invoiceId: string; invoiceNumber: string | null; amount: string }> }>> {
    const payments = await (manager ?? this.dataSource).getRepository(SupplierPayment).find({ order: { occurredAt: 'DESC' } });
    if (payments.length === 0) return [];

    const supplierIds = [...new Set(payments.map((p) => p.supplierId))];
    const allAllocations = await (manager ?? this.dataSource).getRepository(SupplierPaymentAllocation).find({ where: { supplierPaymentId: In(payments.map((p) => p.id)) } });
    const invoiceIds = [...new Set([...payments.map((p) => p.supplierInvoiceId), ...allAllocations.map((a) => a.supplierInvoiceId)])];
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
      allocations: allAllocations
        .filter((a) => a.supplierPaymentId === p.id)
        .map((a) => ({ invoiceId: a.supplierInvoiceId, invoiceNumber: invoiceNumberById.get(a.supplierInvoiceId) ?? null, amount: a.amount })),
    }));
  }
}
