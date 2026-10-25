import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type PayoutItemStatus = 'pending' | 'paid' | 'failed';

/**
 * Addendum A-7 — one payment to one employee. The unique `idempotencyKey` (`payout:{runLineId}:{seq}`) is the duplicate guard: the item row and the Treasury
 * transaction are written in the same transaction, so a replay either finds the existing item (and returns it) or fails on the unique index — it can never
 * create a second cash movement. A failed item stays as history; a re-issue is a NEW item (next `seq`) pointing at it through `supersedesItemId`.
 */
@Entity('payroll_payout_items')
export class PayrollPayoutItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  payoutBatchId!: string;

  @Index()
  @Column('uuid')
  payrollRunId!: string;

  @Column('uuid')
  payrollRunLineId!: string;

  @Column('uuid')
  employeeId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Column({ type: 'int' })
  seq!: number;

  @Column({ type: 'varchar', length: 128 })
  idempotencyKey!: string;

  @Column({ type: 'varchar', length: 12, default: 'pending' })
  status!: PayoutItemStatus;

  @Column('uuid', { nullable: true })
  treasuryTransactionId!: string | null;

  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;

  @Column('uuid', { nullable: true })
  supersedesItemId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  settledAt!: Date | null;
}
