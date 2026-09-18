import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-054/ADR-056 (Month-End Closing, Phase 8). GRNI↔GL reconciliation —
 * the mirror of `ApReconciliationRun` (ADR-037 D2/D4), with the identical
 * "no operational subledger source yet" shape:
 *   - `subledgerTotalBase` is NULLABLE (NULL = no GRNI ledger source);
 *   - `status` adds `'no_subledger_source'` — a run that could only compute
 *     the GL side. **It is NEVER reported as `matched`** until Procurement's
 *     GRNI posting logic exists and binds `GRNI_LEDGER_CONTRACT`.
 *
 * Read-only — a reconciliation never posts a correcting entry.
 */
@Entity('accounting_grni_reconciliation_runs')
export class GrniReconciliationRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  fiscalPeriodId!: string | null;

  @Column({ type: 'date' })
  asOfDate!: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  subledgerTotalBase!: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  glBalanceBase!: string;

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
