import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-070 (Payroll Phase 1) — Periods, Compensation, Runs, Run Detail
 * screens. `field.employee`, `field.status`, `field.actions`, `field.
 * reason`, `action.confirm`/`action.cancel` already exist and are reused
 * as-is (confirmed live in the HR/Attendance Phase 1 frontends).
 */
export class SeedPayrollPhase1Terminology1789740200000 implements MigrationInterface {
  name = 'SeedPayrollPhase1Terminology1789740200000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['module.payroll', 'field', 'الرواتب', 'Payroll'],
    ['nav.payroll_periods', 'field', 'فترات الرواتب', 'Payroll Periods'],
    ['nav.payroll_compensation', 'field', 'بيانات الأجر', 'Compensation'],
    ['nav.payroll_runs', 'field', 'دورات الرواتب', 'Payroll Runs'],
    ['nav.payroll_run_detail', 'field', 'تفاصيل دورة الرواتب', 'Payroll Run Detail'],

    ['field.period_code', 'field', 'كود الفترة', 'Period Code'],
    ['field.component_code', 'field', 'بند الأجر', 'Earning Component'],
    ['field.amount', 'field', 'المبلغ', 'Amount'],
    ['field.gross_pay', 'field', 'إجمالي الأجر', 'Gross Pay'],
    ['field.total_deductions', 'field', 'إجمالي الخصومات', 'Total Deductions'],
    ['field.net_pay', 'field', 'صافي الأجر', 'Net Pay'],
    ['field.commission_amount', 'field', 'مبلغ العمولة', 'Commission Amount'],
    ['field.overtime_amount', 'field', 'مبلغ الوقت الإضافي', 'Overtime Amount'],
    ['field.run_code', 'field', 'كود الدورة', 'Run Code'],
    ['field.day_type', 'field', 'نوع اليوم', 'Day Type'],
    ['field.pay_impact', 'field', 'الأثر على الأجر', 'Pay Impact'],
    ['field.financial_event_status', 'field', 'حالة القيد المالي', 'Financial Event Status'],
    ['field.disbursement_status', 'field', 'حالة الصرف', 'Disbursement Status'],
    ['field.treasury_account', 'field', 'حساب الخزينة', 'Treasury Account'],
    ['field.adjustment_kind', 'field', 'نوع التسوية', 'Adjustment Kind'],
    ['field.amount_delta', 'field', 'فرق المبلغ', 'Amount Delta'],
    ['field.calendar_date', 'field', 'التاريخ', 'Date'],

    ['action.create_period', 'action', 'إنشاء فترة', 'Create Period'],
    ['action.create_compensation', 'action', 'حفظ بيانات الأجر', 'Save Compensation'],
    ['action.add_earning_line', 'action', 'إضافة بند أجر', 'Add Earning Line'],
    ['action.calculate_run', 'action', 'احتساب الدورة', 'Calculate Run'],
    ['action.review_run', 'action', 'مراجعة الدورة', 'Review Run'],
    ['action.submit_run', 'action', 'تقديم للاعتماد', 'Submit for Approval'],
    ['action.disburse_run', 'action', 'صرف الدورة', 'Disburse Run'],
    ['action.create_adjustment', 'action', 'تسجيل تسوية', 'Create Adjustment'],
    ['action.view_details', 'action', 'عرض التفاصيل', 'View Details'],

    ['panel.no_periods_yet', 'panel', 'لا توجد فترات رواتب بعد', 'No payroll periods yet'],
    ['panel.no_compensations_yet', 'panel', 'لا توجد بيانات أجر بعد', 'No compensation records yet'],
    ['panel.no_runs_yet', 'panel', 'لا توجد دورات رواتب بعد', 'No payroll runs yet'],
    ['panel.no_lines_yet', 'panel', 'لا توجد بنود بعد', 'No lines yet'],
    ['panel.no_classifications_yet', 'panel', 'لا يوجد تصنيف أيام بعد', 'No day classifications yet'],
    ['panel.no_adjustments_yet', 'panel', 'لا توجد تسويات بعد', 'No adjustments yet'],
    ['panel.reconciliation_gaps', 'panel', 'فجوات تسوية مالية', 'Reconciliation Gaps'],
    ['panel.no_reconciliation_gaps', 'panel', 'لا توجد فجوات — كل الدورات المرحّلة مؤكدة ماليًا', 'No gaps — every posted run is financially confirmed'],
    [
      'panel.payroll_three_states_notice',
      'panel',
      'حالة الدورة (posted)، حالة القيد المالي (Financial Event)، وحالة الصرف (Treasury) ثلاث حالات منفصلة — اكتمال إحداها لا يعني اكتمال الأخرى.',
      'PayrollRun status, Financial Event status, and Treasury disbursement status are three separate states — one being complete does not mean the others are.',
    ],
    [
      'panel.payroll_commission_pending_notice',
      'panel',
      'استهلاك نتائج العمولة المعتمدة من Commission لم يُفعَّل بعد في هذا الإصدار.',
      'Consumption of Approved Commission Results is not yet wired in this release.',
    ],

    ['value.payroll_run_status.draft', 'field', 'مسودة', 'Draft'],
    ['value.payroll_run_status.calculated', 'field', 'محتسبة', 'Calculated'],
    ['value.payroll_run_status.reviewed', 'field', 'تمت المراجعة', 'Reviewed'],
    ['value.payroll_run_status.approved', 'field', 'معتمدة', 'Approved'],
    ['value.payroll_run_status.posted', 'field', 'مرحّلة', 'Posted'],

    ['value.payroll_period_status.open', 'field', 'مفتوحة', 'Open'],
    ['value.payroll_period_status.closed', 'field', 'مغلقة', 'Closed'],

    ['value.financial_event_status.received', 'field', 'مستلم', 'Received'],
    ['value.financial_event_status.mapped', 'field', 'تمت المطابقة', 'Mapped'],
    ['value.financial_event_status.posted', 'field', 'مرحّل', 'Posted'],
    ['value.financial_event_status.rejected', 'field', 'مرفوض', 'Rejected'],
    ['value.financial_event_status.ignored', 'field', 'متجاهل', 'Ignored'],
    ['value.financial_event_status.none', 'field', 'لم يُرحّل بعد', 'Not yet posted'],

    ['value.disbursement_status.pending', 'field', 'قيد الانتظار', 'Pending'],
    ['value.disbursement_status.disbursed', 'field', 'تم الصرف', 'Disbursed'],

    ['value.day_type.working', 'field', 'يوم عمل', 'Working'],
    ['value.day_type.weekend', 'field', 'عطلة أسبوعية', 'Weekend'],
    ['value.day_type.holiday', 'field', 'عطلة رسمية', 'Holiday'],
    ['value.day_type.approved_leave', 'field', 'إجازة معتمدة', 'Approved Leave'],
    ['value.day_type.unclassified', 'field', 'غير مصنّف', 'Unclassified'],

    ['value.pay_impact.none', 'field', 'بدون أثر', 'None'],
    ['value.pay_impact.deduction', 'field', 'خصم', 'Deduction'],
    ['value.pay_impact.leave', 'field', 'إجازة', 'Leave'],

    ['value.adjustment_kind.adjustment', 'field', 'تسوية', 'Adjustment'],
    ['value.adjustment_kind.correction', 'field', 'تصحيح', 'Correction'],
    ['value.adjustment_kind.recalculation', 'field', 'إعادة احتساب', 'Recalculation'],
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
