import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F05 — Accounts Payable (ADR-037 D2, Blueprint §8). One AP↔GL
 * reconciliation execution. The mirror of `ArReconciliationRun`, with two
 * differences forced by "there is no operational AP subledger yet"
 * (ADR-037 D1):
 *   - `subledgerTotalBase` is NULLABLE (NULL = no supplier-ledger source);
 *   - `status` adds `'no_subledger_source'` — a run that could only
 *     compute the GL side. **It is NEVER reported as `matched`** (CTO
 *     decision, ADR-037 D4).
 *
 * Read-only — a reconciliation never posts a correcting entry;
 * `driftBase ≠ 0` is flagged and an accountant posts an approved
 * adjustment. Plain `status` (CHECK), not a `ProcessDefinition`.
 */
@Entity('accounting_ap_reconciliation_runs')
export class ApReconciliationRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  fiscalPeriodId!: string | null;

  @Column({ type: 'date' })
  asOfDate!: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  /** NULL when there is no supplier-ledger source (ADR-037 D2). */
  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  subledgerTotalBase!: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  glBalanceBase!: string;

  /** NULL when `subledgerTotalBase` is NULL. */
  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  driftBase!: string | null;

  @Column({ type: 'varchar', length: 24 })
  status!: 'open' | 'matched' | 'drift_found' | 'closed' | 'no_subledger_source';

  @Column({ type: 'jsonb', nullable: true })
  driftBreakdown!: Record<string, unknown> | null;

  @Column({ type: 'uuid' })
  runByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt!: Date | null;
}
