import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core`-tagged (ADR-025). Product Search / Selection UI/UX Requirement
 * (2026-09-17) — the Warehouse transaction line search and the Inventory
 * grid filter both became a name-primary searchable combobox instead of a
 * "search by product name or code" free-text box. Updates the existing
 * `field.search_product_placeholder` wording to match (name-first, code no
 * longer implied as required) and adds the new empty-results label the
 * combobox needs. Same idempotent (`ON CONFLICT`) shape as every other
 * terminology seed.
 */
export class SeedProductComboboxTerminology1789660000000 implements MigrationInterface {
  name = 'SeedProductComboboxTerminology1789660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES
       ('field.search_product_placeholder', 'field', 'ابحث باسم المنتج…', 'Search by product name…'),
       ('panel.no_matching_products', 'panel', 'لا توجد منتجات مطابقة', 'No matching products')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "terminology_entries" SET "ar" = 'ابحث برمز المنتج أو الاسم لإضافة بند…', "en" = 'Search SKU or product name to add a line…', "version" = "version" + 1 WHERE code = 'field.search_product_placeholder'`,
    );
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = 'panel.no_matching_products'`);
  }
}
