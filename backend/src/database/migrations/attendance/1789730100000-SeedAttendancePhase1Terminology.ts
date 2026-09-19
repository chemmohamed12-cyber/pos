import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `attendance`-tagged (ADR-025). ADR-065 (Attendance Phase 1) — Connectors
 * & Mapping, Import, and Days & Approvals screens. `field.employee`,
 * `field.status`, `field.actions`, `field.created_at`, `field.reason`,
 * `action.confirm`/`action.save`/`action.cancel` already exist and are
 * reused as-is (confirmed live in the HR Phase 1 frontend).
 */
export class SeedAttendancePhase1Terminology1789730100000 implements MigrationInterface {
  name = 'SeedAttendancePhase1Terminology1789730100000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['module.attendance', 'field', 'الحضور والانصراف', 'Attendance'],
    ['nav.attendance_connectors', 'field', 'الأجهزة والربط', 'Connectors & Mapping'],
    ['nav.attendance_import', 'field', 'استيراد الحضور', 'Attendance Import'],
    ['nav.attendance_days', 'field', 'أيام الحضور والاعتماد', 'Days & Approvals'],

    ['field.connector_name', 'field', 'اسم المصدر', 'Connector Name'],
    ['field.connector_type', 'field', 'نوع المصدر', 'Connector Type'],
    ['field.device_ref', 'field', 'معرّف الجهاز/الموظف', 'Device/Employee Ref'],
    ['field.punch_timestamp', 'field', 'وقت البصمة', 'Punch Timestamp'],
    ['field.punch_type', 'field', 'نوع البصمة', 'Punch Type'],
    ['field.check_in', 'field', 'وقت الحضور', 'Check-in'],
    ['field.check_out', 'field', 'وقت الانصراف', 'Check-out'],
    ['field.hours_worked', 'field', 'ساعات العمل', 'Hours Worked'],
    ['field.calendar_date', 'field', 'التاريخ', 'Date'],
    ['field.period_start', 'field', 'بداية الفترة', 'Period Start'],
    ['field.period_end', 'field', 'نهاية الفترة', 'Period End'],
    ['field.file_name', 'field', 'اسم الملف', 'File Name'],
    ['field.total_rows', 'field', 'إجمالي الصفوف', 'Total Rows'],
    ['field.succeeded_count', 'field', 'عدد الناجح', 'Succeeded'],
    ['field.rejected_count', 'field', 'عدد المرفوض', 'Rejected'],

    ['action.create_connector', 'action', 'إضافة مصدر', 'Add Connector'],
    ['action.close_mapping', 'action', 'إغلاق الربط', 'Close Mapping'],
    ['action.create_mapping', 'action', 'ربط موظف', 'Map Employee'],
    ['action.record_manual_punch', 'action', 'تسجيل بصمة يدوية', 'Record Manual Punch'],
    ['action.download_template', 'action', 'تحميل القالب', 'Download Template'],
    ['action.upload_file', 'action', 'رفع الملف', 'Upload File'],
    ['action.preview_import', 'action', 'معاينة الاستيراد', 'Preview Import'],
    ['action.confirm_import', 'action', 'تأكيد الاستيراد', 'Confirm Import'],
    ['action.correct_day', 'action', 'تصحيح اليوم', 'Correct Day'],
    ['action.submit_batch', 'action', 'تقديم دفعة للاعتماد', 'Submit Approval Batch'],

    ['panel.no_connectors_yet', 'panel', 'لا توجد مصادر بعد', 'No connectors yet'],
    ['panel.no_mappings_yet', 'panel', 'لا يوجد ربط بعد', 'No mappings yet'],
    ['panel.no_unmapped_records_yet', 'panel', 'لا توجد بصمات غير مرتبطة', 'No unmapped records'],
    ['panel.no_days_yet', 'panel', 'لا توجد أيام حضور بعد', 'No attendance days yet'],
    ['panel.no_batches_yet', 'panel', 'لا توجد دفعات اعتماد بعد', 'No approval batches yet'],

    ['value.attendance_day_status.present', 'field', 'حاضر', 'Present'],
    ['value.attendance_day_status.absent', 'field', 'غائب', 'Absent'],
    ['value.attendance_day_status.on_leave', 'field', 'في إجازة', 'On Leave'],
    ['value.attendance_day_status.missing_punch', 'field', 'بصمة ناقصة', 'Missing Punch'],

    ['value.punch_type.in', 'field', 'حضور', 'In'],
    ['value.punch_type.out', 'field', 'انصراف', 'Out'],
    ['value.punch_type.unknown', 'field', 'غير محدد', 'Unknown'],

    ['value.attendance_batch_status.draft', 'field', 'مسودة', 'Draft'],
    ['value.attendance_batch_status.submitted', 'field', 'تم التقديم', 'Submitted'],
    ['value.attendance_batch_status.approved', 'field', 'معتمدة', 'Approved'],
    ['value.attendance_batch_status.rejected', 'field', 'مرفوضة', 'Rejected'],

    ['value.connector_status.pending', 'field', 'قيد الإعداد', 'Pending'],
    ['value.connector_status.connected', 'field', 'متصل', 'Connected'],
    ['value.connector_status.disconnected', 'field', 'غير متصل', 'Disconnected'],
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
