import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Phase D-2 (D6) - a supplier credit note: a financial correction LINKED to the original supplier invoice and its lines (price / value credit; goods that physically go back are returned through a
 * Purchase Return, which credits the same invoice line). Lifecycle (`supplier_credit_note_lifecycle`): draft -> submitted -> approved -> posted, with rejected / void. A posted credit note is never edited or
 * voided; a mistake is corrected by a new document. It never rewrites the invoice, a payment or a journal: it adds a Supplier Ledger debit and its own GL events.
 */
@Entity('supplier_credit_notes')
export class SupplierCreditNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  creditNoteNumber!: string;

  @Index()
  @Column('uuid')
  supplierInvoiceId!: string;

  @Column('uuid')
  supplierId!: string;

  /** The supplier's own credit-note number, when they sent one. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  supplierReference!: string | null;

  @Column({ type: 'varchar', length: 255 })
  reason!: string;

  /** Net value credited (sum of the lines). */
  @Column({ type: 'numeric', precision: 14, scale: 2 })
  netAmount!: string;

  /** Input VAT credited back, proportional to the invoice's VAT (net credited / invoice net), never above the VAT not yet credited. */
  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  taxAmount!: string;

  @Column('uuid')
  createdByUserId!: string;

  @Column({ type: 'uuid', nullable: true })
  submittedByUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  approvedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  postedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt!: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  rejectedReason!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  voidedReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
