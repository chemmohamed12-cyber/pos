import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-070 §4/§B — one or more rows per `PayrollCompensation`. Together
 * these sum to Gross Pay (`ADR-067 §B`'s Earnings stage) — no single-
 * figure salary column exists anywhere in this module. `componentCode`'s
 * exact catalog is Implementation detail (`ADR-070 §21`), not a business-
 * policy gap; `'basic'` is the only value this Phase 1 slice assumes,
 * and only as a default label, never a hardcoded rule.
 */
@Entity('payroll_earning_lines')
export class PayrollEarningLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  compensationId!: string;

  @Column({ type: 'varchar', length: 32 })
  componentCode!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;
}
