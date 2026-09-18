import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F03 — General Ledger (Blueprint §3.2, ADR-035 D4). One line of a journal
 * entry. `(debit > 0) XOR (credit > 0)` — never both, never neither —
 * enforced by a DB CHECK constraint AND the service. Amounts are
 * `NUMERIC` and every sum/equality over them is computed in SQL, never in
 * JavaScript (ADR-035 D4).
 */
@Entity('accounting_journal_lines')
@Index(['journalEntryId', 'lineNumber'], { unique: true })
export class JournalLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  journalEntryId!: string;

  @Column({ type: 'int' })
  lineNumber!: number;

  @Index()
  @Column({ type: 'uuid' })
  accountId!: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  description!: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 4, default: 0 })
  debitTransaction!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4, default: 0 })
  creditTransaction!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4, default: 0 })
  debitBase!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4, default: 0 })
  creditBase!: string;

  /** The exact `ExchangeRate.rate` applied; `'1'` when transaction currency == functional currency (F01 §3.7 — no skip path). */
  @Column({ type: 'numeric', precision: 18, scale: 8, default: 1 })
  exchangeRateUsed!: string;

  @Column({ type: 'date' })
  exchangeRateDate!: string;

  /** Line scope; must equal or descend from the entry's `orgUnitId`. */
  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
