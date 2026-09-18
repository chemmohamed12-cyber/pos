import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Snapshotted from the sales order line's own historical values at draft-creation time — never re-read live product prices (same discipline as `SalesOrderLine` itself and Returns Phase A's `ReturnCredit`). */
@Entity('sales_invoice_lines')
export class SalesInvoiceLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  salesInvoiceId!: string;

  @Column({ type: 'uuid', nullable: true })
  salesOrderLineId!: string | null;

  @Column('uuid')
  productId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  unitPrice!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  discountAmount!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  lineTotal!: string;
}
