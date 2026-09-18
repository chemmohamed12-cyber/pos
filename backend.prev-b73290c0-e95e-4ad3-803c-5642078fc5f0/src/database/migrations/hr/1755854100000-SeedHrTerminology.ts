import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ERP Foundation — P9 (ADR-029). `hr`-tagged (ADR-025) — every string the
 * `hr` frontend pages render comes from the Terminology Registry, same rule
 * as every other module (ADR-011) — no hard-coded UI strings.
 */
export class SeedHrTerminology1755854100000 implements MigrationInterface {
  name = 'SeedHrTerminology1755854100000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['module.hr', 'field', 'الموارد البشرية', 'HR'],
    ['nav.hr_employees', 'field', 'الموظفون', 'Employees'],
    ['nav.hr_departments', 'field', 'الأقسام', 'Departments'],
    ['field.full_name', 'field', 'الاسم الكامل', 'Full Name'],
    ['field.department', 'field', 'القسم', 'Department'],
    ['field.position', 'field', 'الوظيفة', 'Position'],
    ['field.hire_date', 'field', 'تاريخ التعيين', 'Hire Date'],
    ['panel.no_employees_yet', 'field', 'لا يوجد موظفون بعد', 'No employees yet'],
    ['panel.no_departments_yet', 'field', 'لا توجد أقسام بعد', 'No departments yet'],
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
