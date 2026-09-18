import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Customer Financial Account / Invoice / AR (CTO directive) — no status
 * column, same "single owner of state" discipline as `SalesOrder`/
 * `ReturnRequest`/`Shipment`: the Process Engine (`sales_invoice_lifecycle`)
 * is the single source of truth. Part of the Sales Order → Delivery →
 * Invoice → AR → Payment → Treasury chain, not a separate silo —
 * `salesOrderId` links back, lines snapshot the order's own historical
 * prices (never re-read live product prices), same discipline Returns
 * Phase A already established for `ReturnCredit`.
 */
@Entity('sales_invoices')
export class SalesInvoice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  invoiceNumber!: string;

  @Index()
  @Column('uuid')
  customerId!: string;

  @Index()
  @Column('uuid')
  salesOrderId!: string;

  @Column({ type: 'uuid', nullable: true })
  shipmentId!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  subtotal!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  discountAmount!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  taxAmount!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  totalAmount!: string;

  /** Resolved from `Customer.paymentTermsDays` at draft-creation time — null if the customer has no payment terms set. */
  @Column({ type: 'timestamptz', nullable: true })
  dueDate!: Date | null;

  @Column('uuid')
  createdByUserId!: string;

  @Column({ type: 'uuid', nullable: true })
  postedByUserId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  voidedReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
