import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F06 — Cash & Bank (ADR-038 D9). One Cash/Bank↔GL reconciliation
 * execution, **per Treasury account** (each Treasury account maps to one
 * GL `bank` account). The mirror of `ApReconciliationRun`, but:
 *   - keyed by `treasuryAccountId` + `glAccountCode` (F06 reconciles a
 *     specific account, not one global run);
 *   - `subledgerTotalBase` / `driftBase` are **NOT NULL** — the Treasury
 *     operational ledger (the subledger source) always exists, so unlike
 *     F05 there is no `no_subledger_source` state.
 *
 * Read-only — a reconciliation never posts a correcting entry;
 * `driftBase ≠ 0` is flagged and an accountant posts an approved
 * adjustment (FA-01). Plain `status` (CHECK), not a `ProcessDefinition`.
 */
@Entity('accounting_cash_bank_reconciliation_runs')
export class CashBankReconciliationRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  treasuryAccountId!: string;

  @Column({ type: 'varchar', length: 32 })
  glAccountCode!: string;

  @Column({ type: 'uuid', nullable: true })
  fiscalPeriodId!: string | null;

  @Column({ type: 'date' })
  asOfDate!: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  /** Σ of the Treasury operational ledger for this account, base currency, SQL NUMERIC. */
  @Column({ type: 'numeric', precision: 20, scale: 4 })
  subledgerTotalBase!: string;

  /** the GL `bank` account balance, base currency. */
  @Column({ type: 'numeric', precision: 20, scale: 4 })
  glBalanceBase!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  driftBase!: string;

  @Column({ type: 'varchar', length: 24 })
  status!: 'open' | 'matched' | 'drift_found' | 'closed';

  @Column({ type: 'jsonb', nullable: true })
  driftBreakdown!: Record<string, unknown> | null;

  @Column({ type: 'uuid' })
  runByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt!: Date | null;
}
