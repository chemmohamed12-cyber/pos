import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { ProductStatus } from '../domain/product-status';

/**
 * V1-minimal Catalog (blueprint §9): single price per product, no
 * variants/price-lists yet — enough for Sales Orders (item 24) to
 * reference a priced line item. Variants/price-lists are additive later
 * without breaking this contract (ADR-016).
 */
@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  sku!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  unitPrice!: string;

  /**
   * Warehouse ERP V1 / Phase 1 Integration (CTO directive §3 — Inventory
   * Control column list). A plain descriptive label ("قطعة"/"كرتونة",
   * "Piece"/"Carton") shown on the Inventory Grid — deliberately NOT a
   * unit-of-measure/conversion engine (no base-unit, no pack-size
   * conversion math); that would be over-engineering V1's scope. Null
   * for any product where it was never set, shown as "—" in the UI.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  unit!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: ProductStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
