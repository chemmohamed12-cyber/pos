import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D2 (2026-10-04, CTO-approved) — Treasury Accounts screen: GL mapping column/editor strings. Mapped/Unmapped
 * status and the "requires mapping before financial posting" hint. Same idempotent seed shape as every other
 * terminology migration.
 */
export class SeedTreasuryGlMappingTerminology1789850000000 implements MigrationInterface {
  name = 'SeedTreasuryGlMappingTerminology1789850000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['field.gl_mapping', 'field', 'ربط حساب الأستاذ', 'GL Mapping'],
    ['value.gl_mapping.mapped', 'value', 'مربوط', 'Mapped'],
    ['value.gl_mapping.unmapped', 'value', 'غير مربوط', 'Unmapped'],
    ['panel.gl_mapping_required', 'panel', 'يتطلب الربط بحساب أستاذ قبل أي ترحيل مالي', 'Requires GL mapping before financial posting'],
    ['action.save_gl_mapping', 'action', 'حفظ الربط', 'Save Mapping'],
    ['action.clear_gl_mapping', 'action', 'إلغاء الربط', 'Clear Mapping'],
    ['panel.select_gl_account', 'panel', 'اختر حساب الأستاذ', 'Select GL account'],
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
