import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `accounting`-tagged (ADR-025). Same gap class as
 * `SeedArAndFiscalClosingRequestTypeTitles1789623729706`, found the same
 * way (live in `Approvals.tsx`'s request-type picker): F12
 * (`FixedAssetDisposalService.onModuleInit`, `action.fixed_asset_dispose`)
 * and F07 (`InventoryAdjustmentService.onModuleInit`,
 * `action.inventory_${kind}`) register their FA-01 request types with
 * titleCodes that were never seeded. Same idempotent (`ON CONFLICT`)
 * shape as every other terminology seed.
 */
export class SeedFixedAssetAndInventoryRequestTypeTitles1789623849097 implements MigrationInterface {
  name = 'SeedFixedAssetAndInventoryRequestTypeTitles1789623849097';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['action.fixed_asset_dispose', 'field', 'اعتماد استبعاد الأصل', 'Approve Fixed Asset Disposal'],
    ['action.inventory_physical_count_variance', 'field', 'اعتماد فرق الجرد الفعلي', 'Approve Physical Count Variance'],
    ['action.inventory_valuation_write_down', 'field', 'اعتماد تخفيض قيمة المخزون', 'Approve Valuation Write-down'],
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
