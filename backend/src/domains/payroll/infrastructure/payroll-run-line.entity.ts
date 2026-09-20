import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-070 §4 — one per employee per `PayrollRun`. `compensationSnapshot`
 * is a copy of the `PayrollCompensation`/`PayrollEarningLine` values used
 * at calculation time (the immutable-snapshot discipline `ADR-068 §F`
 * already established for Commission, applied here) — never a live
 * reference. `commissionAmount` is reserved for `ADR-071`'s own Approved
 * Commission Result consumption (not yet wired in this slice — Commission
 * itself is not built yet); `overtimeAmount` is always `0`/`null` in
 * Phase 1, a reserved column per `ADR-067 §D`'s deferred extension point.
 */
@Entity('payroll_run_lines')
export class PayrollRunLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  payrollRunId!: string;

  @Index()
  @Column('uuid')
  employeeId!: string;

  @Column({ type: 'jsonb' })
  compensationSnapshot!: Record<string, unknown>;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  grossPay!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  totalDeductions!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  netPay!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  commissionAmount!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  overtimeAmount!: string | null;

  @Column({ type: 'timestamptz' })
  calculationTimestamp!: Date;
}
