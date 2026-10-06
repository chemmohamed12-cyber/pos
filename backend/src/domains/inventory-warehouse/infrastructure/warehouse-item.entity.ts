import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * D1 (2026-10-05) — Item↔Warehouse assignment: master data saying an item belongs to a warehouse. Many-to-many, UNIQUE per
 * pair. Deliberately has NO quantity/value column: stock is always `SUM(stock_movements)` (ADR-007).
 */
@Entity('warehouse_items')
@Unique('UQ_warehouse_items_pair', ['warehouseId', 'productId'])
export class WarehouseItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  warehouseId!: string;

  @Index('IDX_warehouse_items_product')
  @Column('uuid')
  productId!: string;

  @Column({ type: 'uuid', nullable: true })
  assignedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
