import { MigrationInterface, QueryRunner } from 'typeorm';

/** Gap G-4 (EXCEL_BUSINESS_MAPPING_PACKAGE.md) — line-level discount UI. */
export class SeedDiscountTerminology1755845400000 implements MigrationInterface {
  name = 'SeedDiscountTerminology1755845400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.discount_amount', 'field', 'قيمة الخصم', 'Discount'],
    ];

    for (const [code, category, ar, en] of seed) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [['field.discount_amount']]);
  }
}
