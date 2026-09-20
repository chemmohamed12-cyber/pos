import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-071 (Targets Phase 1) — the Targets screen. `field.employee`,
 * `field.status`, `field.actions`, `value.approval_status.*` already
 * exist and are reused as-is (confirmed live in the Payroll/Attendance
 * Phase 1 frontends).
 */
export class SeedTargetsPhase1Terminology1789750200000 implements MigrationInterface {
  name = 'SeedTargetsPhase1Terminology1789750200000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['module.targets', 'field', 'المستهدفات', 'Targets'],
    ['nav.targets', 'field', 'المستهدفات', 'Targets'],

    ['field.period_start', 'field', 'بداية الفترة', 'Period Start'],
    ['field.period_end', 'field', 'نهاية الفترة', 'Period End'],
    ['field.target_value', 'field', 'قيمة المستهدف', 'Target Value'],

    ['action.create_target', 'action', 'إنشاء مستهدف', 'Create Target'],
    ['action.submit_target', 'action', 'تقديم للاعتماد', 'Submit for Approval'],

    ['panel.no_targets_yet', 'panel', 'لا توجد مستهدفات بعد', 'No targets yet'],

    ['value.target_status.draft', 'field', 'مسودة', 'Draft'],
    ['value.target_status.pending_approval', 'field', 'بانتظار الاعتماد', 'Pending Approval'],
    ['value.target_status.approved', 'field', 'معتمد', 'Approved'],
    ['value.target_status.rejected', 'field', 'مرفوض', 'Rejected'],
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
