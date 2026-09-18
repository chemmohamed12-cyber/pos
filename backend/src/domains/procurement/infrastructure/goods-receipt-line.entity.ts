import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('goods_receipt_lines')
export class GoodsReceiptLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  goodsReceiptId!: string;

  @Index()
  @Column('uuid')
  purchaseOrderLineId!: string;

  @Index()
  @Column('uuid')
  productId!: string;

  @Column({ type: 'numeric', precision: 18, scale: 3 })
  quantityReceived!: string;

  /** Copied from the PO line at receipt time — never re-priced here (3-way match compares this against the PO line's own cost, not a caller-supplied override). */
  @Column({ type: 'numeric', precision: 18, scale: 4 })
  unitCostBase!: string;
}
