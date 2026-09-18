import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('purchase_order_lines')
export class PurchaseOrderLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  purchaseOrderId!: string;

  @Index()
  @Column('uuid')
  productId!: string;

  @Column({ type: 'numeric', precision: 18, scale: 3 })
  quantity!: string;

  @Column({ type: 'numeric', precision: 18, scale: 4 })
  unitCostBase!: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  lineTotalBase!: string;

  /** Sum of every posted `GoodsReceiptLine.quantityReceived` against this line — the 3-way-match / over-receipt guard reads this, never re-sums on every check. */
  @Column({ type: 'numeric', precision: 18, scale: 3, default: 0 })
  quantityReceived!: string;

  /** Sum of every posted `SupplierInvoiceLine.quantity` against this line — the 3-way-match over-invoicing guard (invoiced can never exceed received) reads this, never re-sums on every check. */
  @Column({ type: 'numeric', precision: 18, scale: 3, default: 0 })
  quantityInvoiced!: string;
}
