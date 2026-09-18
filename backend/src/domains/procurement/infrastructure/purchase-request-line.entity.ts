import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('purchase_request_lines')
export class PurchaseRequestLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  purchaseRequestId!: string;

  @Index()
  @Column('uuid')
  productId!: string;

  @Column({ type: 'numeric', precision: 18, scale: 3 })
  quantity!: string;

  @Column({ type: 'date', nullable: true })
  neededByDate!: string | null;
}
