import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F04 — Accounts Receivable (ADR-036 D2, Blueprint §11). One AR↔GL
 * reconciliation execution: the Σ of the `customer-finance` subledger
 * (read via `FINANCE_CUSTOMER_LEDGER_CONTRACT.getAllCustomerBalances`)
 * against the `ar` control account's GL balance
 * (`LedgerService.getAccountLedger`). Read-only — a reconciliation never
 * posts a correcting entry; `driftBase ≠ 0` is flagged and an accountant
 * posts an approved adjustment.
 *
 * Plain `status` (CHECK), not a `ProcessDefinition` (Decision D-08 — the
 * lifecycle is tiny, same call as F02's `GLAccount.isActive`).
 */
@Entity('accounting_ar_reconciliation_runs')
export class ArReconciliationRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** either a fiscal period or a free as-of date drives the "≤ this date" cut. */
  @Column({ type: 'uuid', nullable: true })
  fiscalPeriodId!: string | null;

  @Column({ type: 'date' })
  asOfDate!: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  subledgerTotalBase!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  glBalanceBase!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  driftBase!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: 'open' | 'matched' | 'drift_found' | 'closed';

  /** per-customer / per-journal drift breakdown when `driftBase ≠ 0` — jsonb, diagnostic only. */
  @Column({ type: 'jsonb', nullable: true })
  driftBreakdown!: Record<string, unknown> | null;

  @Column({ type: 'uuid' })
  runByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt!: Date | null;
}
