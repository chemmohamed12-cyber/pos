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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt!: Date | null;
}
