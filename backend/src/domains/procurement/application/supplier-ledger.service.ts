import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { utcDayEndExclusiveSql } from '../../../foundation/localization/business-date';
import { DataSource, EntityManager } from 'typeorm';
import { SupplierLedgerEntry } from '../infrastructure/supplier-ledger-entry.entity';
import { SupplierLedgerDirection, SupplierLedgerEntryType } from '../domain/supplier-ledger-entry-type';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { SupplierLedgerContract } from '../../../foundation/module-registry/contracts/ap-events.contract';

const LEDGER_ENTRY_DOCUMENT_TYPE = 'supplier_ledger_entry';
const LEDGER_ENTRY_PREFIX = 'SLE';

export interface PostSupplierLedgerEntryInput {
  supplierId: string;
  /** Widened to `string` (not `SupplierLedgerEntryType`) so this method's signature satisfies `SupplierLedgerContract.postEntry` exactly — every in-domain caller still only ever passes a real `SupplierLedgerEntryType` literal. */
  entryType: SupplierLedgerEntryType | (string & {});
  direction: SupplierLedgerDirection;
  amount: string;
  purchaseOrderId?: string | null;
  supplierInvoiceId?: string | null;
  supplierPaymentId?: string | null;
  treasuryTransactionId?: string | null;
  reference?: string | null;
  reason?: string | null;
  createdByUserId: string;
}

/**
 * ADR-048 — the Supplier Ledger's own service. The exact mirror of
 * `CustomerLedgerService` for a liability (credit-normal) subledger
 * instead of an asset (debit-normal) one — every SQL balance formula is
 * the sign-flip of the customer side. Implements `SupplierLedgerContract`
 * so `AccountingModule`'s `ApReconciliationService`/`ApAdjustmentService`
 * (both already coded against this interface, `@Optional()`-injected,
 * dormant since ADR-037) activate for real once this binds
 * `SUPPLIER_LEDGER_CONTRACT` — see `ProcurementModule`.
 */
@Injectable()
export class SupplierLedgerService implements SupplierLedgerContract {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  async postEntry(input: PostSupplierLedgerEntryInput, manager?: EntityManager): Promise<SupplierLedgerEntry> {
    if (!Number.isFinite(Number(input.amount)) || Number(input.amount) <= 0) {
      throw new BadRequestException('Ledger entry amount must be a positive number.');
    }

    await this.numbering.registerDocumentType(LEDGER_ENTRY_DOCUMENT_TYPE, LEDGER_ENTRY_PREFIX, true, manager);
    const entryNumber = await this.numbering.getNextNumber(LEDGER_ENTRY_DOCUMENT_TYPE, manager);

    const runner = manager ?? this.dataSource;
    const repo = runner.getRepository(SupplierLedgerEntry);
    const saved = await repo.save(
      repo.create({
        entryNumber,
        supplierId: input.supplierId,
        entryType: input.entryType as SupplierLedgerEntryType,
        direction: input.direction,
        amount: input.amount,
        purchaseOrderId: input.purchaseOrderId ?? null,
        supplierInvoiceId: input.supplierInvoiceId ?? null,
        supplierPaymentId: input.supplierPaymentId ?? null,
        treasuryTransactionId: input.treasuryTransactionId ?? null,
        reference: input.reference ?? null,
        reason: input.reason ?? null,
        entryDate: new Date(),
        createdByUserId: input.createdByUserId,
        reversalOfEntryId: null,
        status: 'posted',
      }),
    );

    await this.audit.record(
      {
        actorUserId: input.createdByUserId,
        organizationId: null,
        action: 'procurement.supplier_ledger.entry_posted',
        resource: 'supplier_ledger_entry',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after: { supplierId: input.supplierId, entryType: input.entryType, direction: input.direction, amount: input.amount, supplierInvoiceId: saved.supplierInvoiceId },
      },
      manager,
    );

    return saved;
  }

  /** `credit - debit` — the mirror of `CustomerLedgerService.getCustomerBalance`'s `debit - credit` (AP is credit-normal). Positive = we owe the supplier. */
  async getSupplierBalance(supplierId: string, manager?: EntityManager): Promise<string> {
    const runner = manager ?? this.dataSource;
    const rows = await runner.query(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END), 0) AS balance
       FROM "supplier_ledger_entries" WHERE "supplierId" = $1`,
      [supplierId],
    );
    return Number(rows[0].balance).toFixed(2);
  }

  /** `SupplierLedgerContract.getAllSupplierBalances` — the read `ApReconciliationService` compares Σ of against the `ap` control account's GL balance. Multi-Company Area 9 (2026-09-22) — `manager?` added so a company-scoped caller (`ClosingSnapshotService`) can run this against that Company's own connection instead of the ambient one. Falls back to the ambient `this.dataSource` when omitted, unchanged for every existing caller. */
  async getAllSupplierBalances(asOfDate?: string, manager?: EntityManager): Promise<{ balances: Array<{ supplierId: string; balance: string }>; total: string }> {
    const runner = manager ?? this.dataSource;
    const params: unknown[] = [];
    let dateClause = '';
    if (asOfDate) {
      params.push(asOfDate);
      // UTC calendar day, independent of the DB session timezone — symmetric with the GL side's
      // UTC-stamped `businessDate` (see foundation/localization/business-date.ts).
      dateClause = `WHERE "entryDate" < ${utcDayEndExclusiveSql('$1')}`;
    }
    const rows = await runner.query(
      `SELECT "supplierId",
              COALESCE(SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END), 0)::numeric(20,4) AS balance
       FROM "supplier_ledger_entries" ${dateClause}
       GROUP BY "supplierId"
       HAVING COALESCE(SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END), 0) <> 0
       ORDER BY "supplierId"`,
      params,
    );
    const [tot] = await runner.query(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END), 0)::numeric(20,4) AS total
       FROM "supplier_ledger_entries" ${dateClause}`,
      params,
    );
    return {
      balances: rows.map((r: { supplierId: string; balance: string }) => ({ supplierId: r.supplierId, balance: r.balance })),
      total: tot.total,
    };
  }

  /** Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added — called from `SupplierInvoiceService.voidInvoice`, reachable via the Company-scoped `supplier-invoice.controller.ts`. */
  async reverseEntry(entryId: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<SupplierLedgerEntry> {
    const repo = (manager ?? this.dataSource).getRepository(SupplierLedgerEntry);
    const original = await repo.findOne({ where: { id: entryId } });
    if (!original) throw new NotFoundException(`Supplier ledger entry "${entryId}" not found.`);
    if (original.status !== 'posted') {
      throw new ConflictException(`Cannot reverse a ledger entry in status "${original.status}".`);
    }

    await this.numbering.registerDocumentType(LEDGER_ENTRY_DOCUMENT_TYPE, LEDGER_ENTRY_PREFIX, true, manager);
    const entryNumber = await this.numbering.getNextNumber(LEDGER_ENTRY_DOCUMENT_TYPE, manager);

    const reversal = await (manager ?? this.dataSource).transaction(async (txManager) => {
      const mRepo = txManager.getRepository(SupplierLedgerEntry);
      const saved = await mRepo.save(
        mRepo.create({
          entryNumber,
          supplierId: original.supplierId,
          entryType: original.entryType,
          direction: original.direction === 'debit' ? 'credit' : 'debit',
          amount: original.amount,
          purchaseOrderId: original.purchaseOrderId,
          supplierInvoiceId: original.supplierInvoiceId,
          supplierPaymentId: original.supplierPaymentId,
          treasuryTransactionId: original.treasuryTransactionId,
          reference: original.reference,
          reason: `Reversal: ${reason}`,
          entryDate: new Date(),
          createdByUserId: actorUserId,
          reversalOfEntryId: original.id,
          status: 'posted',
        }),
      );
      await mRepo.update(original.id, { status: 'reversed' });
      return saved;
    });

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'procurement.supplier_ledger.entry_reversed',
        resource: 'supplier_ledger_entry',
        resourceId: original.id,
        result: 'success',
        correlationId: null,
        before: { status: 'posted' },
        after: { status: 'reversed', reversalEntryId: reversal.id, reason },
      },
      manager,
    );

    return reversal;
  }

  async listLedger(supplierId: string, filter?: { from?: string; to?: string }, manager?: EntityManager): Promise<SupplierLedgerEntry[]> {
    const repo = (manager ?? this.dataSource).getRepository(SupplierLedgerEntry);
    const qb = repo.createQueryBuilder('e').where('e.supplierId = :supplierId', { supplierId });
    if (filter?.from) qb.andWhere('e.entryDate >= :from', { from: filter.from });
    if (filter?.to) qb.andWhere('e.entryDate <= :to', { to: filter.to });
    qb.orderBy('e.entryDate', 'ASC').addOrderBy('e.createdAt', 'ASC');
    return qb.getMany();
  }
}
