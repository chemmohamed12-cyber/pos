import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Master data step 2 (approved 2026-10-16) — labels for the scan-or-type item code in the shared product picker (Purchase
 * Request, Purchase Order, warehouse transactions, Inventory filter, BOM). Data only; both codes are new (checked against every
 * existing seed), so `ON CONFLICT` never rewrites an existing label; `down` removes exactly these.
 */
export class SeedBarcodeLookupTerminology1790015400000 implements MigrationInterface {
  name = 'SeedBarcodeLookupTerminology1790015400000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['panel.barcode_not_found', 'panel', 'لا يوجد صنف بهذا الكود أو الباركود — اختر الصنف من القائمة', 'No item has this code or barcode — pick the item from the list'],
    ['panel.barcode_not_available', 'panel', 'الصنف موجود لكنه غير متاح للاختيار هنا (غير نشط أو خارج النطاق)', 'The item exists but cannot be selected here (not active, or out of scope)'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
