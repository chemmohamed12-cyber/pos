import { MigrationInterface, QueryRunner } from 'typeorm';

/** `hr`-tagged (ADR-025). ADR-059 (HR Phase 1) — Departments edit, Employee expansion (employment type, linked user, termination), and the new Leave Requests screen. `action.save`/`action.cancel`/`field.reason`/`field.name`/`field.code`/`field.status`/`field.actions`/`field.start_date`/`field.end_date`/`field.created_at` already exist and are reused as-is. */
export class SeedHrPhase1Terminology1789710300000 implements MigrationInterface {
  name = 'SeedHrPhase1Terminology1789710300000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.hr_leave_requests', 'field', 'طلبات الإجازة', 'Leave Requests'],

    ['field.employment_type', 'field', 'نوع التوظيف', 'Employment Type'],
    ['field.linked_user', 'field', 'حساب المستخدم المرتبط', 'Linked User'],
    ['field.termination_reason', 'field', 'سبب إنهاء الخدمة', 'Termination Reason'],
    ['field.termination_date', 'field', 'تاريخ إنهاء الخدمة', 'Termination Date'],
    ['field.employee', 'field', 'الموظف', 'Employee'],
    ['field.leave_type', 'field', 'نوع الإجازة', 'Leave Type'],

    ['action.edit_department', 'action', 'تعديل القسم', 'Edit Department'],
    ['action.terminate_employee', 'action', 'إنهاء خدمة الموظف', 'Terminate Employee'],
    ['action.link_user', 'action', 'ربط حساب مستخدم', 'Link User'],
    ['action.confirm', 'action', 'تأكيد', 'Confirm'],
    ['action.submit_leave_request', 'action', 'تقديم طلب إجازة', 'Submit Leave Request'],
    ['action.hr_submit_leave_request', 'action', 'تقديم طلب إجازة', 'Submit Leave Request'],

    ['panel.no_leave_requests_yet', 'panel', 'لا توجد طلبات إجازة بعد', 'No leave requests yet'],

    ['value.employment_type.full_time', 'field', 'دوام كامل', 'Full Time'],
    ['value.employment_type.part_time', 'field', 'دوام جزئي', 'Part Time'],
    ['value.employment_type.contractor', 'field', 'متعاقد', 'Contractor'],

    ['value.leave_request_status.submitted', 'field', 'تم التقديم', 'Submitted'],
    ['value.leave_request_status.approved', 'field', 'معتمدة', 'Approved'],

    ['value.leave_type.annual', 'field', 'سنوية', 'Annual'],
    ['value.leave_type.sick', 'field', 'مرضية', 'Sick'],
    ['value.leave_type.unpaid', 'field', 'بدون أجر', 'Unpaid'],
    ['value.leave_type.other', 'field', 'أخرى', 'Other'],
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
