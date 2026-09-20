import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PayrollDeductionCategory } from '../domain/payroll-run-status';

/**
 * ADR-070 §4/§G — `ADR-067 §G`'s closed two-category taxonomy:
 * `system_derived` (tax, social insurance, approved attendance-related
 * deductions — none of which are computed in this Phase 1 slice, per
 * `ADR-067 §E`'s escalation) vs. `approved_external` (a loan repayment,
 * an advance — from an approved administrative source, never a bare UI
 * action). `sourceReference` is required whenever `category =
 * 'approved_external'` — enforced in `PayrollService`, not just here.
 */
@Entity('payroll_deduction_lines')
export class PayrollDeductionLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  payrollRunLineId!: string;

  @Column({ type: 'varchar', length: 16 })
  category!: PayrollDeductionCategory;

  @Column({ type: 'varchar', length: 32 })
  type!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Column('uuid', { nullable: true })
  sourceReference!: string | null;
}
