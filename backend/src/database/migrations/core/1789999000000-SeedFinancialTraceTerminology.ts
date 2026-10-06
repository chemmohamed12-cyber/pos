import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NAV-07 (2026-10-06) — Financial traceability block on operational documents (Document -> Financial status -> Financial event -> Journal).
 * `field.financial_status` already exists and is deliberately NOT re-seeded here. Idempotent; every text <= 255 characters.
 */
export class SeedFinancialTraceTerminology1789999000000 implements MigrationInterface {
  name = 'SeedFinancialTraceTerminology1789999000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['panel.financial_trace_title', 'panel', 'الأثر المالي للمستند', 'Financial impact of this document'],
    ['panel.financial_trace_none', 'panel', 'لا يوجد حدث مالي لهذا المستند بعد.', 'No financial event for this document yet.'],
    ['field.financial_event', 'field', 'الحدث المالي', 'Financial event'],
    ['action.open_journal', 'action', 'فتح القيد', 'Open journal'],
    ['value.financial_trace.pending', 'value', 'قيد المعالجة', 'Pending'],
    ['value.financial_trace.posted', 'value', 'مُرحَّل', 'Posted'],
    ['value.financial_trace.rejected', 'value', 'مرفوض', 'Rejected'],
    ['value.financial_trace.ignored', 'value', 'بلا أثر مالي', 'No financial effect'],
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
