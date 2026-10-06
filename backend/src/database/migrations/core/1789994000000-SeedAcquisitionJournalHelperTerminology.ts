import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D8 acquisition-journal helper (2026-10-06, CTO Option C — Acquisition Clearing) — Fixed Assets screen. Same idempotent seed shape as every other
 * terminology migration.
 */
export class SeedAcquisitionJournalHelperTerminology1789994000000 implements MigrationInterface {
  name = 'SeedAcquisitionJournalHelperTerminology1789994000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['action.create_acquisition_journal', 'action', 'إنشاء قيد الاقتناء تلقائيًا', 'Create acquisition journal'],
    [
      'panel.create_acquisition_journal_hint',
      'panel',
      'مدين حساب تكلفة الأصل / دائن حساب تسوية اقتناء الأصول الثابتة (المُهيَّأ في الإعدادات)، ثم يُرحَّل ويُربط فيصبح الأصل نشطًا. لا يمس الموردين أو الخزينة.',
      'Dr the asset cost account / Cr the configured Fixed Asset Acquisition Clearing account; posted and linked so the asset becomes active. It does not touch payables or treasury.',
    ],
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
