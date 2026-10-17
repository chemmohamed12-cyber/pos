import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F07 — Inventory Accounting (ADR-040 D10). One Inventory↔GL
 * reconciliation execution. The mirror of `ApReconciliationRun`, with the
 * same shape forced by "there is no valuation source yet" (ADR-040 D3):
 *   - `subledgerTotalBase` is NULLABLE (NULL = no valuation source);
 *   - `status` adds `'no_valuation_source'`. **Never reported as
 *     `matched`** until F08 (Inventory Valuation) binds a real
 *     `InventoryValuationContract` (CTO Mandatory Condition E).
 *
 * Read-only — a reconciliation never posts a correcting entry;
 * `driftBase ≠ 0` (once a valuation source exists) is flagged and an
 * accountant posts an approved FA-01 adjustment. Plain `status` (CHECK),
 * not a `ProcessDefinition`.
 */
@Entity('accounting_inventory_reconciliation_runs')
export class InventoryReconciliationRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  fiscalPeriodId!: string | null;

  @Column({ type: 'date' })
  asOfDate!: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  /** NULL when there is no valuation source (ADR-040 D3). */
  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  subledgerTotalBase!: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  glBalanceBase!: string;

  /** NULL when `subledgerTotalBase` is NULL. */
  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  driftBase!: string | null;

  @Column({ type: 'varchar', length: 24 })
  status!: 'open' | 'matched' | 'drift_found' | 'closed' | 'no_valuation_source';

  @Column({ type: 'jsonb', nullable: true })
  driftBreakdown!: Record<string, unknown> | null;

  @Column({ type: 'uuid' })
  runByUserId!: string;

  /** Slice C1 (ADR-INV-09) - the part of `driftBase` covered by itemised categories (NULL on runs written before reconciliation v2). */
  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  explainedBase!: string | null;

  /** The remainder after the itemised categories; NULL on older runs. */
  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  unexplainedBase!: string | null;

  /** How the valuation side was read: `current` (running state) or `as_of` (rebuilt from the dated history). */
  @Column({ type: 'varchar', length: 16, nullable: true })
  basis!: 'current' | 'as_of' | null;

  /** `matched` (difference exactly 0) | `explained` (non-zero, fully explained) | `unexplained`. `status` keeps its original values and meaning. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  classification!: 'matched' | 'explained' | 'unexplained' | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt!: Date | null;
}
