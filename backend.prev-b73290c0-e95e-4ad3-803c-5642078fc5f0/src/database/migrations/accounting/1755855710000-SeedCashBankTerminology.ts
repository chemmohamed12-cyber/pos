import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F06 — Cash & Bank (ADR-038, ADR-011). Cash/Bank-specific Terminology
 * Registry rows. Generic reconciliation/adjustment/approval strings are
 * reused from F04/F05's seeds. `ON CONFLICT`-idempotent; working `down()`.
 */
export class SeedCashBankTerminology1755855710000 implements MigrationInterface {
  name = 'SeedCashBankTerminology1755855710000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['nav.cash_bank_reconciliation', 'nav', 'النقدية والبنوك', 'Cash & Bank'],
    ['perm.accounting.cash', 'permission', 'النقدية والبنوك', 'Cash & Bank'],
    ['perm.accounting.cash.view', 'permission', 'عرض النقدية والبنوك', 'View Cash & Bank'],
    ['perm.accounting.cash.create', 'permission', 'تشغيل تسوية النقدية والبنوك', 'Run Cash/Bank Reconciliation'],
    ['perm.accounting.cash.adjust', 'permission', 'تقديم تسوية نقدية/بنكية', 'Submit Cash/Bank Adjustment'],
    ['perm.accounting.cash.approve', 'permission', 'اعتماد تسوية نقدية/بنكية', 'Approve Cash/Bank Adjustment'],
    ['feat.accounting.cash_bank', 'field', 'النقدية والبنوك', 'Cash & Bank'],

    ['value.cash_bank_adjustment_kind.bank_adjustment', 'field', 'مصروف/عمولة بنكية', 'Bank Charge / Fee'],
    ['value.cash_bank_adjustment_kind.opening_balance', 'field', 'رصيد افتتاحي', 'Opening Balance'],
    ['value.cash_bank_adjustment_kind.unreconciled_write_off', 'field', 'إسقاط فرق غير مُسوّى', 'Unreconciled Write-off'],
    ['value.cash_bank_adjustment_kind.reclassification', 'field', 'إعادة تصنيف من الحساب الوسيط', 'Reclassification'],

    ['action.cash_bank_adjustment', 'field', 'اعتماد مصروف بنكي', 'Approve Bank Charge'],
    ['action.cash_opening_balance', 'field', 'اعتماد رصيد افتتاحي (نقدية/بنك)', 'Approve Cash/Bank Opening Balance'],
    ['action.cash_unreconciled_write_off', 'field', 'اعتماد إسقاط فرق غير مُسوّى', 'Approve Unreconciled Write-off'],
    ['action.cash_reclassification', 'field', 'اعتماد إعادة تصنيف', 'Approve Reclassification'],
    ['action.submit_cash_bank_adjustment', 'field', 'تقديم تسوية نقدية/بنكية', 'Submit Cash/Bank Adjustment'],
    ['action.load_cash_bank_statement', 'field', 'عرض كشف النقدية/البنك', 'Load Cash/Bank Statement'],

    ['field.treasury_account', 'field', 'حساب الخزينة', 'Treasury Account'],
    ['field.gl_account_code', 'field', 'رمز حساب الأستاذ', 'GL Account Code'],
    ['field.treasury_ledger_total', 'field', 'إجمالي دفتر الخزينة', 'Treasury Ledger Total'],
    ['field.counter_account_code', 'field', 'رمز الحساب المقابل', 'Counter Account Code'],

    ['panel.cash_bank_reconciliation_matched', 'field', 'دفتر الخزينة يطابق حساب البنك في الأستاذ', 'The Treasury ledger matches the GL bank account'],
    ['panel.cash_bank_reconciliation_drift', 'field', 'يوجد فرق بين دفتر الخزينة وحساب البنك في الأستاذ', 'The Treasury ledger and the GL bank account differ'],
    ['panel.cash_bank_position_statement', 'field', 'كشف مركز النقدية/البنك', 'Cash/Bank Position Statement'],
    ['panel.no_cash_bank_reconciliations_yet', 'field', 'لا توجد تسويات نقدية/بنكية بعد', 'No Cash/Bank reconciliations yet'],
    ['panel.cash_bank_adjustment_submitted_approval', 'field', 'تم تقديم التسوية للاعتماد (صانع/مراجع)', 'Adjustment submitted for approval (maker-checker)'],
    ['panel.cash_bank_adjustment_posted', 'field', 'تم ترحيل التسوية إلى دفتر الأستاذ', 'Adjustment posted to the General Ledger'],
    ['panel.cash_bank_not_gl_mapped', 'field', 'حساب الخزينة غير مربوط بحساب أستاذ', 'This Treasury account is not GL-mapped'],
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
