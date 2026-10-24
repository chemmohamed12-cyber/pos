import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Manufacturing Engine S2 (decision D-ME-2) — "1 <unitCode> = <factor> base units" for one product; the base unit is `products.unit`. */
@Entity('product_unit_conversions')
export class ProductUnitConversion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  productId!: string;

  @Column({ type: 'varchar', length: 32 })
  unitCode!: string;

  @Column({ type: 'int' })
  factor!: number;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
