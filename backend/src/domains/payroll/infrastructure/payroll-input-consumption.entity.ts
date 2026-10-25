import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type PayrollInputKind = 'commission_result' | 'commission_adjustment' | 'payroll_adjustment';
export type PayrollInputState = 'reserved' | 'consumed' | 'released';

/**
 * Addendum A-2/A-3 — Payroll's own record that a commission result / adjustment is held by a run revision. The partial unique index
 * `UQ_payroll_input_consumptions_live_source` (inputKind, sourceId WHERE state IN ('reserved','consumed')) makes double use impossible even under
 * concurrency. The source rows (CommissionResult, CommissionAdjustment, PayrollAdjustment) are never modified.
 */
@Entity('payroll_input_consumptions')
export class PayrollInputConsumption {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 24 })
  inputKind!: PayrollInputKind;

  @Column('uuid')
  sourceId!: string;

  @Index()
  @Column('uuid')
  payrollRunId!: string;

  @Column('uuid', { nullable: true })
  payrollRunLineId!: string | null;

  @Column('uuid')
  employeeId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Column({ type: 'varchar', length: 12, default: 'reserved' })
  state!: PayrollInputState;

  @Column({ type: 'boolean', default: false })
  carriedForward!: boolean;

  @Column({ type: 'date', nullable: true })
  attributionDate!: string | null;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  detail!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  releasedAt!: Date | null;
}
