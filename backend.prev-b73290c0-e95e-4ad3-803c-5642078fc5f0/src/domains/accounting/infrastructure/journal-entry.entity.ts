import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { JournalSourceType } from '../domain/journal';

/**
 * F03 — General Ledger (Blueprint §3.1, ADR-035 D3). One journal entry.
 * No `status` column — live state via `ProcessEngineService.getState(
 * 'accounting_journal_entry', id)` (F01 convention). Append-only once
 * POSTED: the only follow-on is a reversing entry (ADR-035 D3).
 *
 * The four `total…` columns are maintained = Σ of the lines and MUST be
 * equal (transaction currency AND base currency) before POST — the check
 * itself runs in SQL `NUMERIC` (ADR-035 D4); these columns are the
 * denormalised summary for list/detail reads.
 */
@Entity('accounting_journal_entries')
export class JournalEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** From `NumberingService` at POST time (ADR-035 D8). NULL until POSTED. Never client-supplied. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32, nullable: true })
  entryNumber!: string | null;

  @Column({ type: 'date' })
  businessDate!: string;

  @Column({ type: 'date', nullable: true })
  postingDate!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  description!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 16 })
  sourceType!: JournalSourceType;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  financialEventId!: string | null;

  /** Set iff `sourceType = 'REVERSAL'`. Partial unique index — an entry may be reversed at most once (ADR-035 D3). */
  @Column({ type: 'uuid', nullable: true })
  reversalOfEntryId!: string | null;

  @Column({ type: 'varchar', length: 3 })
  transactionCurrencyCode!: string;

  /** Denormalised = the base currency AT POST TIME (F01 §3.7 — historical accuracy, not re-derived later). */
  @Column({ type: 'varchar', length: 3 })
  functionalCurrencyCode!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4, default: 0 })
  totalDebitTransaction!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4, default: 0 })
  totalCreditTransaction!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4, default: 0 })
  totalDebitBase!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4, default: 0 })
  totalCreditBase!: string;

  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @Column({ type: 'uuid', nullable: true })
  postedBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt!: Date | null;
}
