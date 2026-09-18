import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * One product's override price within a Price List (Gap G-3). Unique on
 * (priceListId, productId) — one price per product per list, upserted
 * via `PriceListsService.upsertItem`, never duplicated.
 */
@Entity('price_list_items')
@Index(['priceListId', 'productId'], { unique: true })
export class PriceListItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  priceListId!: string;

  @Column('uuid')
  productId!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  price!: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
