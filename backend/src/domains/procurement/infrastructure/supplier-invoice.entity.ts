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
