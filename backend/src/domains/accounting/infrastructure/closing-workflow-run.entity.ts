import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type ClosingWorkflowStatus =
  | 'audit_run'
  | 'exceptions_open'
  | 'final_reconciliation_passed'
  | 'approval_submitted'
  | 'approved'
  | 'period_locked'
  | 'failed';

/**
 * ADR-051 §1/§6 (Month-End Closing / Black Box, Phase 3). One row per
 * closing ATTEMPT (a first close from `soft_close`, or a reclose from
 * `reopened` — `entryState` records which). This is the persisted evidence
 * behind ADR-051 §6's invariant: "Closing Audit → Exception Gate →
 * Exception Resolution → Fresh Final Reconciliation → FA-01 → Period
 * Lock" is a real, checkable sequence for THIS specific closing, not merely
 * inferred after the fact from scattered audit-log entries.
 */
@Entity('accounting_closing_workflow_runs')
export class ClosingWorkflowRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  fiscalPeriodId!: string;

  @Column({ type: 'varchar', length: 16 })
  entryState!: 'soft_close' | 'reopened';

  @Column({ type: 'uuid', nullable: true })
  finalReconciliationRunId!: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  approvalRequestId!: string | null;

  @Column({ type: 'varchar', length: 32 })
  status!: ClosingWorkflowStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
