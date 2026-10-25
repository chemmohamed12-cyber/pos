import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type PayoutBatchStatus = 'draft' | 'executing' | 'completed' | 'partially_completed' | 'failed' | 'cancelled';

/** Addendum A-7 — one disbursement action against a posted run: a stable identity (code), the paying Treasury account and a status derived from its items. */
@Entity('payroll_payout_batches')
export class PayrollPayoutBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Index()
  @Column('uuid')
  payrollRunId!: string;

  @Column('uuid')
  treasuryAccountId!: string;

  @Column({ type: 'varchar', length: 24, nullable: true })
  method!: string | null;

  @Column({ type: 'varchar', length: 24, default: 'draft' })
  status!: PayoutBatchStatus;

  /** How many times this batch has been executed (each execution settles the then-pending items). */
  @Column({ type: 'int', default: 0 })
  executions!: number;

  @Column('uuid')
  createdByUserId!: string;

  @Column('uuid', { nullable: true })
  executedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  executedAt!: Date | null;
}
