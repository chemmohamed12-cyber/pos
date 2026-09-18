import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Snapshotted at draft-creation time from the caller's input, cross-checked against the PO line — never re-read a live PO/product cost after that (same discipline `SalesInvoiceLine` established for sales order prices). */
@Entity('supplier_invoice_lines')
export class SupplierInvoiceLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  supplierInvoiceId!: string;

  @Index()
  @Column('uuid')
  purchaseOrderLineId!: string;

  @Column('uuid')
  productId!: string;

  @Column({ type: 'numeric', precision: 18, scale: 3 })
  quantity!: string;

  @Column({ type: 'numeric', precision: 18, scale: 4 })
  unitCostBase!: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  lineTotalBase!: string;

  /** `unitCostBase` minus the PO line's own `unitCostBase` — the per-line 3-way-match price signal (0 = exact match, may be negative). */
  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  unitCostVariance!: string;
}
