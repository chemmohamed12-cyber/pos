import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { CustomerLedgerEntryType, LedgerDirection } from '../domain/customer-ledger-entry-type';

/**
 * Customer Financial Account / AR (CTO directive) — the Customer Ledger:
 * a real, first-class subledger, append-only, same "the ledger is a sum
 * over real records, never a cached column" discipline as
 * `TreasuryTransaction`/`stock_movements`. `CustomerLedgerService.
 * getCustomerBalance` is the ONLY place a balance is computed — never
 * stored, never edited directly. Never updated after insert except
 * `status` flipping to `reversed`; correction is always a new offsetting
 * row via `CustomerLedgerService.reverseEntry`, linked through
 * `reversalOfEntryId` (same pattern as Treasury's
 * `reversalOfTransactionId`).
 */
@Entity('customer_ledger_entries')
export class CustomerLedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  entryNumber!: string;

  @Index()
  @Column('uuid')
  customerId!: string;

  @Column({ type: 'varchar', length: 32 })
  entryType!: CustomerLedgerEntryType;

  @Column({ type: 'varchar', length: 8 })
  direction!: LedgerDirection;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  salesOrderId!: string | null;

  /**
   * Null means "unapplied" — posted before an invoice existed yet (an
   * early deposit, a COD remitted before invoicing). `InvoiceService.
   * postInvoice` sweeps matching unapplied entries onto the new invoice
   * by setting this column — the one narrow, disclosed exception to
   * immutability (a null→value backfill only, never touching amount/
   * direction/customerId), same spirit as Treasury's
   * `reversalOfTransactionId` being set once.
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  invoiceId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  depositId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  paymentId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  returnCreditId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  shipmentId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  treasuryTransactionId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reference!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  @Column({ type: 'timestamptz' })
  entryDate!: Date;

  @Column('uuid')
  createdByUserId!: string;

  @Column({ type: 'uuid', nullable: true })
  reversalOfEntryId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'posted' })
  status!: 'posted' | 'reversed';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
