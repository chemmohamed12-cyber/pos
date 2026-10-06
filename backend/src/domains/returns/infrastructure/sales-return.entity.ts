import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * A NEW, additive aggregate — general customer return, independent of
 * any specific Shipment (CTO directive §5). `salesOrderId` is nullable:
 * null means "All Orders" mode for this customer, evaluated against the
 * eligibility window at line-creation time — never assume a
 * `SalesReturn` has exactly one order (CTO directive §10/§11).
 * `customerId` is always required (mandatory even in single-order mode,
 * since it's what "All Orders" needs and it must never silently differ
 * from the order's own customer). Line-level provenance to the actual
 * source order/order-line lives on `SalesReturnLine`, never here.
 */
@Entity('sales_returns')
export class SalesReturn {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  returnNumber!: string;

  @Index()
  @Column('uuid')
  customerId!: string;

  /** Null = "All Orders" mode. Non-null = the one order the user picked in the picker UI — still just a UI convenience; provenance is per-line, not enforced from this column. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  salesOrderId!: string | null;

  @Column({ type: 'timestamptz' })
  returnDate!: Date;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  totalAmount!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  @Column('uuid')
  requestedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
  /** D4 — the Customer Ledger credit(s) this document produced (AR reduction / customer credit; never a cash refund). Null ⇒ none. */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  creditedGrossBase!: string | null;
}
