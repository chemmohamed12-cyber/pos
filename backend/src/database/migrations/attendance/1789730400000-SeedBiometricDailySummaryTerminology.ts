import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO directive (2026-09-20) — Attendance Frontend completion for the
 * confirmed real Biometric Daily Attendance Summary format. `field.
 * employee`, `field.status`, `field.actions`, `field.calendar_date`,
 * `field.check_in`, `field.check_out`, `field.reason`, `action.confirm`/
 * `action.cancel`, and every `panel.*`/`action.*` key
 * `SeedAttendancePhase1Terminology` already seeded are reused as-is.
 */
export class SeedBiometricDailySummaryTerminology1789730400000 implements MigrationInterface {
  name = 'SeedBiometricDailySummaryTerminology1789730400000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.attendance_biometric_import', 'field', 'استيراد ملخص البصمة اليومي', 'Biometric Daily Summary Import'],
    ['nav.attendance_facts', 'field', 'حقائق الحضور (المصدر)', 'Attendance Facts (Source)'],

    ['field.ac_no', 'field', 'رقم البصمة (AC-No.)', 'AC-No.'],
    ['field.source_name', 'field', 'الاسم (بيانات مصدر فقط)', 'Name (source data only)'],
    ['field.on_duty', 'field', 'موعد الحضور المجدول', 'On Duty (scheduled)'],
    ['field.off_duty', 'field', 'موعد الانصراف المجدول', 'Off Duty (scheduled)'],
    ['field.late', 'field', 'تأخير (حقيقة من الجهاز)', 'Late (device fact)'],
    ['field.early', 'field', 'انصراف مبكر (حقيقة من الجهاز)', 'Early (device fact)'],
    ['field.absent_flag', 'field', 'غياب (حقيقة من الجهاز)', 'Absent (device fact)'],
    ['field.ot_time', 'field', 'وقت إضافي (حقيقة من الجهاز)', 'OT Time (device fact)'],
    ['field.reconciled_status', 'field', 'الحالة بعد التسوية', 'Reconciled Status'],
    ['field.import_date', 'field', 'تاريخ الاستيراد', 'Import Date'],

    ['action.download_biometric_template', 'action', 'تحميل قالب ملخص البصمة', 'Download Biometric Template'],
    ['action.upload_biometric_file', 'action', 'رفع ملف ملخص البصمة', 'Upload Biometric File'],

    ['panel.no_biometric_unmapped_yet', 'panel', 'لا توجد صفوف بصمة غير مرتبطة', 'No unmapped biometric rows'],
    ['panel.no_biometric_history_yet', 'panel', 'لا يوجد سجل استيراد بصمة بعد', 'No biometric import history yet'],
    ['panel.no_biometric_facts_yet', 'panel', 'لا توجد حقائق بصمة بعد', 'No biometric facts yet'],
    [
      'panel.biometric_facts_not_payroll_notice',
      'panel',
      'التأخير والانصراف المبكر والغياب والوقت الإضافي حقائق من الجهاز فقط — لا تمثل خصمًا أو مستحقًا ماليًا تلقائيًا. القرار المالي يعود بالكامل إلى الرواتب.',
      'Late, Early, Absent, and OT Time are device-reported facts only — none of them represent an automatic financial deduction or payable amount. The pay decision belongs entirely to Payroll.',
    ],
    [
      'panel.biometric_schedule_vs_actual_notice',
      'panel',
      'موعد الحضور/الانصراف المجدول (On duty/Off duty) بيانات جدولة فقط، وليست وقت بصمة فعلي. الوقت الفعلي يأتي فقط من Clock In/Clock Out.',
      'On duty/Off duty is the scheduled window only, not an actual punch time. Real attendance timestamps come only from Clock In/Clock Out.',
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
