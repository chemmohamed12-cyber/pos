import { MigrationInterface, QueryRunner } from 'typeorm';

/** `hr`-tagged (ADR-025). ADR-059 (HR Phase 1) — the Stage 2 (edit employee/manager assignment) and Stage 3 (cancel leave request) additions closing the execution-directive gaps: general employee edit, manager assignment, and leave-request cancellation with its `rejected`/`cancelled` display states (read from the linked ApprovalRequest's own state, never duplicated in `hr_leave_requests.status`). */
export class SeedHrPhase1StageGapsTerminology1789710400000 implements MigrationInterface {
  name = 'SeedHrPhase1StageGapsTerminology1789710400000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['field.manager', 'field', 'المدير المباشر', 'Manager'],
    ['action.edit_employee', 'action', 'تعديل بيانات الموظف', 'Edit Employee'],
    ['action.cancel_leave_request', 'action', 'إلغاء طلب الإجازة', 'Cancel Leave Request'],
    ['value.leave_request_status.rejected', 'field', 'مرفوض', 'Rejected'],
    ['value.leave_request_status.cancelled', 'field', 'ملغى', 'Cancelled'],
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
