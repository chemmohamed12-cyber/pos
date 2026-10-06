import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D5 (2026-10-05, CTO-approved PPV + Input VAT policy) — Supplier Invoice screen: the explicit VAT amount field.
 * Same idempotent seed shape as every other terminology migration.
 */
export class SeedSupplierInvoiceVatTerminology1789920000000 implements MigrationInterface {
  name = 'SeedSupplierInvoiceVatTerminology1789920000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['field.vat_amount', 'field', 'مبلغ ضريبة القيمة المضافة', 'VAT Amount'],
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
