import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PayrollAdjustmentKind } from '../domain/payroll-run-status';

/**
 * ADR-070 §4/§18 — populated only via a correction flow. After a
 * `PayrollRun` reaches `posted`, no `PayrollRunLine`/`PayrollDeductionLine`
 * row is ever updated — only a new row here may reference it. Mirrors
 * `ADR-071`'s `CommissionAdjustment` exactly (the same cross-context
 * immutability rule, `ADR-072 §18`).
 */
@Entity('payroll_adjustments')
export class PayrollAdjustment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  originalPayrollRunLineId!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: PayrollAdjustmentKind;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amountDelta!: string;

  @Column('uuid')
  createdByUserId!: string;

  @Column('uuid', { nullable: true })
  approvalRequestId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
