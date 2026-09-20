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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
