import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * T2 (2026-10-20) — the auditable, one-per-payment record that a customer payment was REVERSED through its owning document. `paymentId` is UNIQUE, so a
 * payment can never be reversed twice even if every application-level guard were bypassed. Append-only: never updated or deleted.
 */
@Entity('customer_payment_reversals')
export class CustomerPaymentReversal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  reversalNumber!: string;

  @Index({ unique: true })
  @Column('uuid')
  paymentId!: string;

  @Column({ type: 'text' })
  reason!: string;

  @Column('uuid')
  reversedByUserId!: string;

  @Column('uuid')
  treasuryReversalTransactionId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
