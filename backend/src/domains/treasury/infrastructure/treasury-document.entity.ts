import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { TreasuryDocumentKind, TreasuryDocumentStatus, TreasuryTransferSubtype } from '../domain/treasury-document';

/**
 * T3 — a Treasury Document (see domain/treasury-document.ts). Never deleted; `executed` documents are corrected only by a linked reversal. `version` is the
 * optimistic-concurrency counter: every state change increments it, and an action that names a stale version is refused.
 */
@Entity('treasury_documents')
export class TreasuryDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  documentNumber!: string;

  @Index()
  @Column({ type: 'varchar', length: 24 })
  kind!: TreasuryDocumentKind;

  @Column({ type: 'varchar', length: 24, nullable: true })
  subtype!: TreasuryTransferSubtype | null;

  @Index()
  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: TreasuryDocumentStatus;

  @Column({ type: 'date' })
  businessDate!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  /** receiving account (collection / receipt), paying account (disbursement), source account (transfer). */
  @Column('uuid')
  treasuryAccountId!: string;

  @Column({ type: 'uuid', nullable: true })
  counterTreasuryAccountId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  customerId!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  method!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reasonCode!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reference!: string | null;

  @Column({ type: 'text', nullable: true })
  purpose!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  unappliedAmount!: string;

  @Column({ type: 'uuid', nullable: true })
  approvalRequestId!: string | null;

  @Column({ type: 'boolean', default: false })
  autoApproved!: boolean;

  @Column('uuid')
  createdByUserId!: string;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  approvedByUserId!: string | null;

  @Column({ type: 'text', nullable: true })
  rejectionNote!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  executedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  executedByUserId!: string | null;

  /** the Treasury leg this document created (the OUT leg for a transfer). */
  @Column({ type: 'uuid', nullable: true })
  executedTransactionId!: string | null;

  /** the customer payment created by a collection. */
  @Column({ type: 'uuid', nullable: true })
  executedPaymentId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reversedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  reversedByUserId!: string | null;

  @Column({ type: 'text', nullable: true })
  reversalReason!: string | null;

  @Column({ type: 'text', nullable: true })
  cancelReason!: string | null;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
