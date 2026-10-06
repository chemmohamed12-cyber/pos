import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D3-B (2026-10-04, CTO-approved Manual Receipt policy) — Receipt form strings: the mandatory controlled reason code
 * and the explicit per-line unit cost. Same idempotent seed shape as every other terminology migration.
 */
export class SeedManualReceiptTerminology1789870000000 implements MigrationInterface {
  name = 'SeedManualReceiptTerminology1789870000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['field.reason_code', 'field', 'رمز السبب', 'Reason Code'],
    ['field.reason_note', 'field', 'ملاحظة السبب', 'Reason Note'],
    ['panel.select_reason_code', 'panel', 'اختر رمز السبب', 'Select reason code'],
    ['panel.no_manual_receipt_reasons', 'panel', 'لا توجد أسباب استلام يدوي مهيأة — اطلب من المحاسبة ربط رمز سبب بحساب مقابل', 'No manual-receipt reasons are configured — ask Accounting to map a reason code to an offset account'],
    ['error.receipt_requires_reason_code', 'error', 'الاستلام اليدوي يتطلب رمز سبب', 'A receipt requires a reason code'],
    ['error.receipt_requires_unit_cost', 'error', 'كل سطر استلام يتطلب تكلفة وحدة أكبر من صفر', 'Every receipt line requires a unit cost greater than zero'],
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
