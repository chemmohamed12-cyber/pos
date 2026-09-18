import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F03 — General Ledger (Blueprint §3.2). Dimension values attached to one
 * journal line, populated per the account's `GLAccountDimensionRule`s
 * (F02) + `accounting.require_dimension_on_pl_accounts` (F02 config,
 * consumed here). Unique `(journalLineId, dimensionTypeId)` — one value
 * per dimension type per line.
 */
@Entity('accounting_journal_line_dimensions')
@Index(['journalLineId', 'dimensionTypeId'], { unique: true })
export class JournalLineDimension {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  journalLineId!: string;

  @Column({ type: 'uuid' })
  dimensionTypeId!: string;

  @Column({ type: 'uuid' })
  dimensionValueId!: string;
}
