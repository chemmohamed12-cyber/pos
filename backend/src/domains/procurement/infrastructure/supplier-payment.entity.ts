import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** ADR-048 — Supplier → Payment → Supplier Ledger → Treasury. Never mutates a balance directly; posts one Treasury `cash_out` and one Supplier Ledger `payment` debit entry, atomically. Mirrors `Payment` (customer-finance). */
@Entity('supplier_payments')
export class SupplierPayment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  paymentNumber!: string;

  @Index()
  @Column('uuid')
  supplierId!: string;

  @Index()
  @Column('uuid')
  supplierInvoiceId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Column({ type: 'varchar', length: 32 })
  method!: string;

  @Column('uuid')
  treasuryAccountId!: string;

  @Column({ type: 'uuid', nullable: true })
  treasuryTransactionId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reference!: string | null;

  @Column('uuid')
  recordedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt!: Date;
}
