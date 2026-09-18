import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { PriceListStatus } from '../domain/price-list-status';
import { PriceListRole } from '../domain/price-list-role';

/**
 * Gap G-3 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §4/§12,
 * `قائمه الاسعار`) — a named header a Customer can be assigned to
 * (`Customer.priceListId`); its line items (`PriceListItem`) carry the
 * actual per-product override prices. `code` is Numbering-issued
 * ('PL-000001'), same discipline as `Customer.code`/`Product.sku`.
 */
@Entity('price_lists')
export class PriceList {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: PriceListStatus;

  /**
   * Post-v1.0.2 Hotfix 3 — Price List priority chain. `null` (the default,
   * every list before this hotfix and every ordinary list created since):
   * an assignable list, same as before. `'main'`: the one default list
   * consulted when a customer has no list of their own assigned.
   * `'general'`: the single system-owned list auto-populated with every
   * product's price at creation time (`PriceListsService`'s subscription
   * to `commerce.product.created`) — never manually assigned through the
   * admin UI. At most one active row holds each role at a time
   * (`IDX_price_lists_role`, enforced defensively at the DB level;
   * `PriceListsService.setRole` is the actual enforcement, auto-clearing
   * whichever list previously held a role before assigning it elsewhere).
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  role!: PriceListRole;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
