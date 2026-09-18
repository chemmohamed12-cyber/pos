import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `hr`-tagged (ADR-025). CTO directive (2026-09-12, "Section Cover / Main
 * Dashboard System" nav-bug fix) — labels for `HrCover.tsx`'s KPI tiles,
 * the same generic `SectionCover` shell every other module's landing page
 * already uses.
 */
export class SeedHrCoverTerminology1755859500000 implements MigrationInterface {
  name = 'SeedHrCoverTerminology1755859500000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['field.total_employees', 'field', 'إجمالي الموظفين', 'Total Employees'],
    ['field.active_employees', 'field', 'الموظفون النشطون', 'Active Employees'],
    ['field.total_departments', 'field', 'إجمالي الأقسام', 'Total Departments'],
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
