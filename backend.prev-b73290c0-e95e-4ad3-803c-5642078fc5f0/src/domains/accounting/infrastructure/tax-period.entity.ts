import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F10 (ADR-043 D8). Reporting-only — a VAT/tax filing period (typically
 * calendar-monthly), deliberately DISTINCT from F01's `FiscalPeriod`
 * (which governs POSTING CONTROL and is unchanged by F10). A `TaxPeriod`
 * carries no posting-control semantics: it never blocks or permits a
 * journal entry, has no FK from `accounting_journal_entries`/`_lines`,
 * and is consumed only by F14 (Reporting, not yet built) to window a
 * query against already-posted GL lines for the `tax_payable`/
 * `tax_receivable` control accounts. Dormant until F14 exists — the same
 * "additive now, activated later" shape F07 used for its own dormant
 * Inventory↔GL reconciliation.
 */
@Entity('accounting_tax_periods')
export class TaxPeriod {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'date' })
  startDate!: string;

  @Column({ type: 'date' })
  endDate!: string;

  @Column({ type: 'varchar', length: 8, nullable: true })
  jurisdictionCode!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
