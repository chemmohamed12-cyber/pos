import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PayrollRunStatus } from '../domain/payroll-run-status';

/**
 * ADR-070 §4/§5 — one per `(PayrollPeriod, populationScope)`. `status` is
 * driven entirely by `ProcessEngineService` (`payroll_run` process
 * definition) — this column mirrors the process instance's own state for
 * convenient querying, it is never written to directly outside a
 * `ProcessEngineService.transition` call. No `financialEventId` field —
 * `ADR-070 §4`'s own correction: reconciliation joins
 * `FinancialEvent.sourceEntityId` back to this row's `id` instead
 * (`financial-event.entity.ts`'s own `sourceDomain`/`sourceEntityType`/
 * `sourceEntityId` triple), matching how every other domain in this
 * codebase already does it — no entity here stores a forward reference.
 */
@Entity('payroll_runs')
export class PayrollRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Index()
  @Column('uuid')
  payrollPeriodId!: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: PayrollRunStatus;

  @Column('uuid', { nullable: true })
  approvalRequestId!: string | null;

  @Column('uuid')
  createdByUserId!: string;

  @Column({ type: 'timestamptz', nullable: true })
  calculatedAt!: Date | null;

  @Column('uuid', { nullable: true })
  reviewedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  disbursedAt!: Date | null;

  /** Addendum A-4 — 1 for the original run; a recalculation after submission, or a supplementary run after posting, takes the next number. */
  @Column({ type: 'int', default: 1 })
  revision!: number;

  /** `regular` = the period's run; `supplementary` = delta-only run for an already-posted period (never rewrites the posted one). */
  @Column({ type: 'varchar', length: 16, default: 'regular' })
  kind!: 'regular' | 'supplementary';

  @Column('uuid', { nullable: true })
  supersedesRunId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  rejectedAt!: Date | null;

  @Column('uuid', { nullable: true })
  rejectedByUserId!: string | null;

  @Column({ type: 'text', nullable: true })
  rejectionReason!: string | null;

  /** Hash of the inputs (compensations, approved attendance batches, commission/adjustment sources) the calculation used — re-checked at submit and at approval. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  inputsFingerprint!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  totalGross!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  totalCommission!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  totalAdjustments!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  totalDeductions!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  totalNet!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
