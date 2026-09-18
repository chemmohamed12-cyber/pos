import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `inventory`-tagged (ADR-025). Frontend recovery/integration pass,
 * Phase 2 gap audit (2026-09-17) — F08's one read-only route
 * (`GET /inventory/valuation/current-cost`, `inventory-valuation.
 * controller.ts`) had zero frontend caller anywhere in the workspace and
 * zero terminology seeded. Per that controller's own doc comment, it
 * exists so a human FA-01 maker can reference the current cost before
 * typing an F07 `physical_count_variance`/`valuation_write_down`
 * adjustment amount — wired into `InventoryAccounting.tsx`'s adjustment
 * form. Same idempotent (`ON CONFLICT`) shape as every other terminology
 * seed.
 */
export class SeedInventoryValuationTerminology1789621100000 implements MigrationInterface {
  name = 'SeedInventoryValuationTerminology1789621100000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['field.current_unit_cost', 'field', 'التكلفة الحالية للوحدة', 'Current Unit Cost'],
    ['action.lookup_current_cost', 'field', 'استعلام عن التكلفة الحالية', 'Look Up Current Cost'],
    ['panel.no_valuation_source', 'field', 'لا يوجد مصدر تقييم لهذا الصنف/المستودع', 'No valuation source for this product/warehouse'],
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
