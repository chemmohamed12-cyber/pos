import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Procurement invoicing redesign, phase A (2026-10-20): how much of a goods receipt line a supplier invoice line covers. A row exists only for a LIVE invoice line (void / cancelled invoices release
 * their rows). `allocationBasis` says where the row comes from: `recorded` = written when the invoice was created (the fact), `backfill_fifo` = rebuilt by the migration for an invoice that predates
 * receipt-level allocation, assuming first-in-first-out against the order's receipts - an inference, NOT a historical fact about which receipt the supplier billed.
 */
@Entity('supplier_invoice_line_receipts')
@Index('UQ_supplier_invoice_line_receipts_pair', ['supplierInvoiceLineId', 'goodsReceiptLineId'], { unique: true })
export class SupplierInvoiceLineReceipt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  supplierInvoiceLineId!: string;

  @Index()
  @Column('uuid')
  goodsReceiptLineId!: string;

  @Column({ type: 'numeric', precision: 18, scale: 3 })
  quantity!: string;

  @Column({ type: 'varchar', length: 16, default: 'recorded' })
  allocationBasis!: 'recorded' | 'backfill_fifo';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
