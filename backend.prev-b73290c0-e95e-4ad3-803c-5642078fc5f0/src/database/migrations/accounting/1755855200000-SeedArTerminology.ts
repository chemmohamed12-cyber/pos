import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F04 — Accounts Receivable (ADR-036). `accounting`-tagged (ADR-025).
 * Every string the F04 frontend renders comes from the Terminology
 * Registry (ADR-011), same pattern as F01/F02/F03.
 */
export class SeedArTerminology1755855200000 implements MigrationInterface {
  name = 'SeedArTerminology1755855200000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['nav.ar_reconciliation', 'field', 'تسوية حسابات العملاء', 'AR Reconciliation'],
    ['field.as_of_date', 'field', 'حتى تاريخ', 'As Of Date'],
    ['field.subledger_total', 'field', 'إجمالي الدفتر الفرعي', 'Subledger Total'],
    ['field.gl_balance', 'field', 'رصيد دفتر الأستاذ', 'GL Balance'],
    ['field.drift', 'field', 'الفرق', 'Drift'],
    ['field.reconciliation_status', 'field', 'حالة التسوية', 'Status'],
    ['field.adjustment_kind', 'field', 'نوع التسوية', 'Adjustment Kind'],
    ['field.approval_status', 'field', 'حالة الموافقة', 'Approval Status'],
    ['value.reconciliation_status.open', 'field', 'مفتوحة', 'Open'],
    ['value.reconciliation_status.matched', 'field', 'مطابَقة', 'Matched'],
    ['value.reconciliation_status.drift_found', 'field', 'يوجد فرق', 'Drift Found'],
    ['value.reconciliation_status.closed', 'field', 'مغلقة', 'Closed'],
    ['value.ar_adjustment_kind.write_off', 'field', 'إعدام دين', 'Write-off'],
    ['value.ar_adjustment_kind.credit_note', 'field', 'إشعار دائن', 'Credit Note'],
    ['value.ar_adjustment_kind.debit_note', 'field', 'إشعار مدين', 'Debit Note'],
    ['value.ar_adjustment_kind.adjustment', 'field', 'تسوية يدوية', 'Manual Adjustment'],
    ['value.ar_adjustment_kind.opening_balance', 'field', 'رصيد افتتاحي', 'Opening Balance'],
    ['value.approval_status.pending', 'field', 'قيد الموافقة', 'Pending'],
    ['value.approval_status.approved', 'field', 'مُوافَق عليها', 'Approved'],
    ['value.approval_status.rejected', 'field', 'مرفوضة', 'Rejected'],
    ['action.run_reconciliation', 'field', 'تشغيل التسوية', 'Run Reconciliation'],
    ['action.submit_ar_adjustment', 'field', 'إرسال تسوية للموافقة', 'Submit AR Adjustment'],
    ['action.decide_approval', 'field', 'اتخاذ قرار', 'Decide'],
    ['panel.no_reconciliations_yet', 'field', 'لا توجد تسويات بعد', 'No reconciliation runs yet'],
    ['panel.ar_reconciliation_matched', 'field', 'الدفتر الفرعي مطابق لدفتر الأستاذ ✓', 'Subledger matches the GL ✓'],
    ['panel.ar_reconciliation_drift', 'field', 'يوجد فرق بين الدفتر الفرعي ودفتر الأستاذ — راجع التفصيل', 'Subledger and GL differ — review the breakdown'],
    ['panel.customer_ar_statement', 'field', 'كشف حساب العميل المحاسبي', 'Customer AR Statement'],
    ['perm.accounting.ar', 'field', 'حسابات العملاء', 'Accounts Receivable'],
    ['role.accounting.ar_approver', 'field', 'معتمِد تسويات العملاء', 'AR Adjustment Approver'],
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
