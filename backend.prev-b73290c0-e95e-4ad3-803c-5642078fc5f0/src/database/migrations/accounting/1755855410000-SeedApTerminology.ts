import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F05 — Accounts Payable (ADR-037, ADR-011). AP-specific Terminology
 * Registry rows. Generic reconciliation/adjustment strings are reused
 * from F04's seed (`field.drift`, `field.gl_balance`,
 * `value.reconciliation_status.*`, `action.run_reconciliation`,
 * `value.approval_status.*`, `value.movement_direction.*`, …). `ON
 * CONFLICT`-idempotent; working `down()`.
 */
export class SeedApTerminology1755855410000 implements MigrationInterface {
  name = 'SeedApTerminology1755855410000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['nav.ap_reconciliation', 'nav', 'الموردون / الذمم الدائنة', 'Accounts Payable'],
    ['perm.accounting.ap', 'permission', 'الذمم الدائنة', 'Accounts Payable'],
    ['role.accounting.ap_approver', 'field', 'مُعتمِد الذمم الدائنة', 'AP Approver'],

    ['value.ap_adjustment_kind.write_off', 'field', 'إسقاط التزام', 'Write-off'],
    ['value.ap_adjustment_kind.credit_note', 'field', 'إشعار دائن من المورد', 'Supplier Credit Note'],
    ['value.ap_adjustment_kind.debit_note', 'field', 'إشعار مدين للمورد', 'Debit Note to Supplier'],
    ['value.ap_adjustment_kind.adjustment', 'field', 'تسوية يدوية', 'Manual Adjustment'],
    ['value.ap_adjustment_kind.opening_balance', 'field', 'رصيد افتتاحي', 'Opening Balance'],

    ['value.reconciliation_status.no_subledger_source', 'field', 'لا يوجد مصدر دفتر مساعد', 'No Subledger Source'],

    ['field.supplier_ref', 'field', 'مرجع المورد', 'Supplier Reference'],
    ['field.ap_account_code', 'field', 'رمز حساب الذمم الدائنة', 'AP Account Code'],

    ['action.submit_ap_adjustment', 'field', 'تقديم تسوية ذمم دائنة', 'Submit AP Adjustment'],
    ['action.load_ap_statement', 'field', 'عرض كشف الذمم الدائنة', 'Load AP Statement'],
    ['action.ap_write_off', 'field', 'اعتماد إسقاط التزام', 'Approve AP Write-off'],
    ['action.ap_credit_note', 'field', 'اعتماد إشعار دائن (مورد)', 'Approve Supplier Credit Note'],
    ['action.ap_debit_note', 'field', 'اعتماد إشعار مدين (مورد)', 'Approve Debit Note to Supplier'],
    ['action.ap_adjustment', 'field', 'اعتماد تسوية ذمم دائنة', 'Approve AP Adjustment'],
    ['action.ap_opening_balance', 'field', 'اعتماد رصيد افتتاحي (ذمم دائنة)', 'Approve AP Opening Balance'],

    ['panel.ap_reconciliation_matched', 'field', 'الدفتر المساعد يطابق دفتر الأستاذ', 'Subledger matches the General Ledger'],
    ['panel.ap_reconciliation_drift', 'field', 'يوجد فرق بين الدفتر المساعد ودفتر الأستاذ', 'The subledger and the General Ledger differ'],
    ['panel.ap_reconciliation_no_source', 'field', 'تسوية الذمم الدائنة غير مُفعّلة — بانتظار مرحلة الموردين التشغيلية', 'AP reconciliation is inactive — awaiting the operational supplier phase'],
    ['panel.supplier_ap_statement', 'field', 'كشف حساب الذمم الدائنة', 'Accounts Payable Statement'],
    ['panel.no_ap_reconciliations_yet', 'field', 'لا توجد تسويات ذمم دائنة بعد', 'No AP reconciliations yet'],
    ['panel.ap_adjustment_submitted_approval', 'field', 'تم تقديم التسوية للاعتماد (صانع/مراجع)', 'Adjustment submitted for approval (maker-checker)'],
    ['panel.ap_adjustment_posted', 'field', 'تم ترحيل التسوية إلى دفتر الأستاذ', 'Adjustment posted to the General Ledger'],
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
