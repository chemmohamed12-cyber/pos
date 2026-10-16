import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Master data step 1 (2026-10-15, M3 / D-MD11) — many barcodes per item, unique per Company; `packLabel` is descriptive only. */
@Entity('product_barcodes')
export class ProductBarcode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  productId!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  barcode!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  packLabel!: string | null;

  @Column({ type: 'boolean', default: false })
  isPrimary!: boolean;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
