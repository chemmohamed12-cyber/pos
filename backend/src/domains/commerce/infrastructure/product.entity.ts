import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { ProductStatus } from '../domain/product-status';
import { ItemType } from '../domain/item-type';

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

  /** Master data step 1 (2026-10-15, D-MD2) — informational classification; drives which item-page sections apply (BOM). */
  @Column({ type: 'varchar', length: 24, default: 'finished_good' })
  itemType!: ItemType;

  @Column({ type: 'uuid', nullable: true })
  categoryId!: string | null;

  /** Set only through the Inventory domain (validated: existing, active, assigned to this item). No FK — same as PR/PO `warehouseId`. */
  @Column({ type: 'uuid', nullable: true })
  defaultWarehouseId!: string | null;

  /** In the base unit (no conversion — D-MD3); numeric string, null = no reorder level. */
  @Column({ type: 'numeric', precision: 18, scale: 3, nullable: true })
  reorderLevel!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
