import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * F12 — Fixed Assets (ADR-045 D3/D8). A CREATION-TIME-ONLY convenience default: pre-fills a new
 * `FixedAsset`'s three account fields from its category. Once copied onto a `FixedAsset` row, that
 * asset's OWN stored account ids are authoritative forever — a later change here never retroactively
 * affects an asset already created (mirrors F11 D10's "an account's own explicit rule always wins over
 * the implicit policy" precedent exactly). Never consulted by the posting path or `assertPostable`.
 */
@Entity('accounting_fixed_asset_category_account_mappings')
export class FixedAssetCategoryAccountMapping {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** F11 `FinancialDimensionValue` id (type `asset_category`). */
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  categoryDimensionValueId!: string;

  @Column({ type: 'uuid' })
  defaultCostAccountId!: string;

  @Column({ type: 'uuid' })
  defaultAccumulatedDepreciationAccountId!: string;

  @Column({ type: 'uuid' })
  defaultDepreciationExpenseAccountId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
