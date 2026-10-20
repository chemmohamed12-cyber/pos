import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BankLineStatus, BankStatementStatus } from '../domain/bank-statement';

/** T5 — an imported bank statement for one Treasury account. Never edited after import except its reconciliation status; duplicate files are refused by the unique (account, fileHash). */
@Entity('bank_statements')
@Index(['treasuryAccountId', 'fileHash'], { unique: true })
export class BankStatement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  systemNumber!: string;

  /** the bank's own statement number / name, as supplied. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  statementNumber!: string | null;

  @Index()
  @Column('uuid')
  treasuryAccountId!: string;

  @Column({ type: 'date' })
  periodStart!: string;

  @Column({ type: 'date' })
  periodEnd!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  openingBalance!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  closingBalance!: string;

  @Column({ type: 'varchar', length: 64 })
  fileHash!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  sourceName!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'imported' })
  status!: BankStatementStatus;

  @Column({ type: 'int' })
  lineCount!: number;

  @Column('uuid')
  importedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  importedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  reconciledAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  reconciledByUserId!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  reconciliationDifference!: string | null;

  @Column({ type: 'int', default: 1 })
  version!: number;
}

@Entity('bank_statement_lines')
@Index(['statementId', 'lineNumber'], { unique: true })
export class BankStatementLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  statementId!: string;

  @Column({ type: 'int' })
  lineNumber!: number;

  @Column({ type: 'date' })
  valueDate!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reference!: string | null;

  /** signed: positive = money into the account. */
  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Index()
  @Column({ type: 'varchar', length: 40 })
  fingerprint!: string;

  /** the same line already exists in ANOTHER statement of this account — flagged, never silently dropped. */
  @Column({ type: 'boolean', default: false })
  possibleDuplicate!: boolean;

  @Column({ type: 'varchar', length: 16, default: 'unmatched' })
  status!: BankLineStatus;

  @Column({ type: 'jsonb', nullable: true })
  suggestion!: { outcome: string; candidates: Array<{ transactionId: string; transactionNumber: string; score: number; reasons: string[] }> } | null;

  @Column({ type: 'int', default: 1 })
  version!: number;
}

/** A confirmed link between one bank line and one Treasury movement. Soft-ended (never deleted) so the audit trail of a correction survives. */
@Entity('bank_statement_matches')
export class BankStatementMatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  lineId!: string;

  @Index()
  @Column('uuid')
  treasuryTransactionId!: string;

  @Column({ type: 'varchar', length: 24 })
  method!: 'suggestion_confirmed' | 'manual';

  @Column('uuid')
  matchedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  matchedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  unmatchedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  unmatchedByUserId!: string | null;

  @Column({ type: 'text', nullable: true })
  unmatchReason!: string | null;
}

/** T5 — a cash custody session (shift): opening float, counted close, variance — immutable once closed except through a controlled reopen. */
@Entity('cash_sessions')
export class CashSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  sessionNumber!: string;

  @Index()
  @Column('uuid')
  treasuryAccountId!: string;

  @Column('uuid')
  custodianUserId!: string;

  @Column({ type: 'varchar', length: 12, default: 'open' })
  status!: 'open' | 'closed';

  @CreateDateColumn({ type: 'timestamptz' })
  openedAt!: Date;

  @Column('uuid')
  openedByUserId!: string;

  /** the BOOK balance when the session opened (the float handed to the custodian). */
  @Column({ type: 'numeric', precision: 14, scale: 2 })
  openingBalance!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  closedByUserId!: string | null;

  /** the book balance at the moment of closing (expected cash). */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  expectedBalance!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  countedAmount!: string | null;

  /** counted − expected (signed): positive = over, negative = short. */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  variance!: string | null;

  @Column({ type: 'text', nullable: true })
  varianceReason!: string | null;

  /** the Treasury Document drafted to resolve the variance (it still needs its own approval and execution). */
  @Column({ type: 'uuid', nullable: true })
  varianceDocumentId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reopenedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  reopenedByUserId!: string | null;

  @Column({ type: 'text', nullable: true })
  reopenReason!: string | null;

  @Column({ type: 'int', default: 1 })
  version!: number;
}
