import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** `B_APPROVE` blocks approval until the cause is fixed and the run recalculated (never acknowledgeable); `A_DOC` allows approval after a documented acknowledgement; `INFO` is recorded, never blocks. */
export type PayrollExceptionClass = 'B_APPROVE' | 'A_DOC' | 'INFO';
export type PayrollExceptionStatus = 'open' | 'acknowledged' | 'resolved';

/**
 * Addendum A-9/A-10 — no silent skip: every condition that would change who is paid, or on what basis, becomes a row tied to the run revision and to a
 * fingerprint of the facts that caused it. A recalculation re-detects exceptions; an acknowledgement is carried over only when the fingerprint is identical.
 */
@Entity('payroll_exceptions')
export class PayrollException {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  payrollRunId!: string;

  @Column('uuid', { nullable: true })
  employeeId!: string | null;

  @Column({ type: 'varchar', length: 48 })
  code!: string;

  @Column({ type: 'varchar', length: 16 })
  impactClass!: PayrollExceptionClass;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  detail!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 64 })
  fingerprint!: string;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: PayrollExceptionStatus;

  @Column({ type: 'text', nullable: true })
  decisionRef!: string | null;

  @Column('uuid', { nullable: true })
  acknowledgedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  acknowledgedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
