import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('supplier_quotation_lines')
export class SupplierQuotationLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  supplierQuotationId!: string;

  @Index()
  @Column('uuid')
  purchaseRequestLineId!: string;

  @Column('uuid')
  productId!: string;

  @Column({ type: 'numeric', precision: 18, scale: 3 })
  quantity!: string;

  @Column({ type: 'numeric', precision: 18, scale: 4 })
  unitCostBase!: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  lineTotalBase!: string;
}
