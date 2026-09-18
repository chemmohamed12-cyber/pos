import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `accounting`-tagged (ADR-025). Same gap class as
 * `SeedArAndFiscalClosingRequestTypeTitles1789623729706` — found live via
 * `Approvals.tsx`'s request-type picker. `FixedAssetDisposalService.
 * onModuleInit` registers `action.fixed_asset_dispose` and
 * `InventoryAdjustmentService.onModuleInit` registers
 * `action.inventory_${kind}` (physical_count_variance/valuation_write_down)
 * as `ApprovalRequestType.titleCode`s; neither was ever seeded. Same
 * idempotent (`ON CONFLICT`) shape as every other terminology seed.
 */
export class SeedFixedAssetInventoryRequestTypeTitles1789623911628 implements MigrationInterface {
  name = 'SeedFixedAssetInventoryRequestTypeTitles1789623911628';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['action.fixed_asset_dispose', 'field', 'اعتماد استبعاد أصل ثابت', 'Approve Fixed Asset Disposal'],
    ['action.inventory_physical_count_variance', 'field', 'اعتماد فرق الجرد الفعلي', 'Approve Physical Count Variance'],
    ['action.inventory_valuation_write_down', 'field', 'اعتماد تخفيض قيمة المخزون', 'Approve Inventory Valuation Write-down'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.terminology) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.terminology.map(([code]) => code)]);
  }
}
