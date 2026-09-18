import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SupplierLedgerDirection, SupplierLedgerEntryType } from '../domain/supplier-ledger-entry-type';

/**
 * ADR-048 — the Supplier Ledger: a real, first-class subledger,
 * append-only, the exact mirror of `CustomerLedgerEntry`. Balance is
 * always derived (`SupplierLedgerService.getSupplierBalance`), never
 * stored. Never updated after insert except `status` flipping to
 * `reversed`; correction is always a new offsetting row via
 * `SupplierLedgerService.reverseEntry`.
 */
@Entity('supplier_ledger_entries')
export class SupplierLedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  entryNumber!: string;

  @Index()
  @Column('uuid')
  supplierId!: string;

  @Column({ type: 'varchar', length: 32 })
  entryType!: SupplierLedgerEntryType;

  @Column({ type: 'varchar', length: 8 })
  direction!: SupplierLedgerDirection;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  purchaseOrderId!: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  supplierInvoiceId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  supplierPaymentId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  treasuryTransactionId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reference!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  @Column({ type: 'timestamptz' })
  entryDate!: Date;

  @Column('uuid')
  createdByUserId!: string;

  @Column({ type: 'uuid', nullable: true })
  reversalOfEntryId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'posted' })
  status!: 'posted' | 'reversed';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
