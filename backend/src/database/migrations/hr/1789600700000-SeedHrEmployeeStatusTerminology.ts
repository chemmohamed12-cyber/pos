import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `hr`-tagged (ADR-025). Frontend recovery/integration pass (2026-09-17) —
 * `HrEmployees.tsx` needs status-value labels (`StatusBadge`) and a couple
 * of action labels that `SeedHrTerminology`/`SeedHrCoverTerminology` didn't
 * cover. Same idempotent (`ON CONFLICT`) shape as every other terminology
 * seed in this codebase.
 */
export class SeedHrEmployeeStatusTerminology1789600700000 implements MigrationInterface {
  name = 'SeedHrEmployeeStatusTerminology1789600700000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['value.employee_status.active', 'field', 'نشط', 'Active'],
    ['value.employee_status.on_leave', 'field', 'في إجازة', 'On Leave'],
    ['value.employee_status.terminated', 'field', 'منتهي الخدمة', 'Terminated'],
    ['action.create_employee', 'field', 'إضافة موظف', 'Add Employee'],
    ['action.create_department', 'field', 'إضافة قسم', 'Add Department'],
    ['action.change_employee_status', 'field', 'تغيير الحالة', 'Change Status'],
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
