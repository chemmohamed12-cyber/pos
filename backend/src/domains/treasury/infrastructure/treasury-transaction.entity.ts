import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TreasuryTransactionStatus } from '../domain/treasury-transaction-status';

export type TreasuryTransactionType = 'cash_in' | 'cash_out' | 'transfer_in' | 'transfer_out';

/**
 * The Ledger — append-only, one row per single-account effect (a
 * Transfer is two rows, one `transfer_out` on the source account and
 * one `transfer_in` on the destination, sharing `transferGroupId`).
 * `amount` is always positive; `type` decides the sign when computing
 * an account's balance (`TreasuryService.getAccountBalance` sums this
 * table — the balance is never stored or edited directly). Never
 * updated after insert except `status` flipping to `reversed`;
 * correction is always a new offsetting row via `TreasuryService.reverseTransaction`,
 * linked back through `reversalOfTransactionId`.
 */
@Entity('treasury_transactions')
export class TreasuryTransaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  transactionNumber!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: TreasuryTransactionType;

  @Index()
  @Column('uuid')
  treasuryAccountId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  customerId!: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  salesOrderId!: string | null;

  /** OP-Procurement/AP Blueprint, Decision 1 (Option A) — the payable-side counterpart to `customerId`/`salesOrderId`. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  supplierId!: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  supplierInvoiceId!: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  depositId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  transferGroupId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reference!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  @Column({ type: 'timestamptz' })
  movementDate!: Date;

  @Column('uuid')
  createdByUserId!: string;

  @Column({ type: 'uuid', nullable: true })
  reversalOfTransactionId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'posted' })
  status!: TreasuryTransactionStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
