import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * ADR-048 — Supplier Invoice / AP. No `status` column — the Process
 * Engine (`supplier_invoice_lifecycle`) is the single source of truth,
 * same discipline as `SalesInvoice`. `purchaseOrderId` links back for the
 * 3-way match; lines snapshot the PO's own historical unit costs at
 * draft-creation time — never re-read a live PO/product cost after that
 * (same discipline `SalesInvoice` already established for order prices).
 */
@Entity('supplier_invoices')
export class SupplierInvoice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  invoiceNumber!: string;

  /** The supplier's OWN reference for this bill — distinct from `invoiceNumber` (our internal sequence), enables the "duplicate invoice" 3-way-match check. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  supplierReference!: string | null;

  @Index()
  @Column('uuid')
  supplierId!: string;

  @Index()
  @Column('uuid')
  purchaseOrderId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  totalAmount!: string;

  /** Resolved from `Supplier.paymentTermsDays` at draft-creation time. */
  @Column({ type: 'timestamptz', nullable: true })
  dueDate!: Date | null;

  /** Σ|line.unitCostBase - matching PO line.unitCostBase| × quantity — 0 when every line matches the PO exactly. Informational (never blocks posting on its own), surfaced to the UI as the 3-way-match price-variance signal. */
  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  priceVarianceAmount!: string;

  /** D5 — the EXPLICIT VAT amount stated by the supplier's invoice. `totalAmount` stays NET; gross = net + taxAmount. */
  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  taxAmount!: string;

  /** D5 — what the receipts credited to GRNI for the invoiced quantities (qty × PO unit cost). NULL on pre-D5 invoices. */
  @Column({ type: 'numeric', precision: 18, scale: 4, nullable: true })
  receiptValueBase!: string | null;

  /** D5 — signed Purchase Price Variance = invoice net − receiptValueBase (positive = invoice higher). NULL on pre-D5 invoices. */
  @Column({ type: 'numeric', precision: 18, scale: 4, nullable: true })
  ppvBase!: string | null;

  @Column('uuid')
  createdByUserId!: string;

  @Column({ type: 'uuid', nullable: true })
  postedByUserId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  voidedReason!: string | null;

  // ---- phase C-1: approval trail and matching result (all nullable; legacy invoices keep NULL) ----
  @Column({ type: 'uuid', nullable: true })
  submittedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  approvedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  /** 'within_tolerance' | 'exceeds_tolerance' - computed at submit from the Company policy; NULL until submitted. */
  @Column({ type: 'varchar', length: 24, nullable: true })
  matchStatus!: string | null;

  /** Per-line variance figures behind `matchStatus` (percentage, amount, which limit was exceeded). */
  @Column({ type: 'jsonb', nullable: true })
  matchDetail!: unknown;

  @Column({ type: 'varchar', length: 500, nullable: true })
  holdReason!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  exceptionReason!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  rejectedReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
