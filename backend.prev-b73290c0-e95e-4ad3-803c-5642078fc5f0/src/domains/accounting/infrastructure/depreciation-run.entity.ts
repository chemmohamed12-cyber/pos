import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F12 — Fixed Assets (ADR-045 D9). One periodic depreciation run. `depreciationPeriod` (`YYYY-MM`) is
 * the authoritative period identity — NEVER inferred from `businessDate` (which defaults to that
 * period's last calendar day and is only used for the fiscal-period-lock check and the resulting
 * `JournalEntry`).
 */
@Entity('accounting_depreciation_runs')
export class DepreciationRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 7 })
  depreciationPeriod!: string;

  @Column({ type: 'date' })
  businessDate!: string;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
