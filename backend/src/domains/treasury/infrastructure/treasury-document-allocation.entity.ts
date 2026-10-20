import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** T3 — how much of a customer-collection document is applied to which invoice (one row per invoice; the remainder, if any, is the document's `unappliedAmount`). */
@Entity('treasury_document_allocations')
@Index(['documentId', 'invoiceId'], { unique: true })
export class TreasuryDocumentAllocation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  documentId!: string;

  @Column('uuid')
  invoiceId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
