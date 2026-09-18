import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F02 — Chart of Accounts (ADR-034). `accounting`-tagged (ADR-025). Every
 * string the F02 frontend renders comes from the Terminology Registry
 * (ADR-011), same pattern as F01's `SeedAccountingTerminology`.
 */
export class SeedChartOfAccountsTerminology1755854700000 implements MigrationInterface {
  name = 'SeedChartOfAccountsTerminology1755854700000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['nav_group.accounting', 'field', 'المحاسبة', 'Accounting'],
    ['nav.chart_of_accounts', 'field', 'دليل الحسابات', 'Chart of Accounts'],
    ['field.account_code', 'field', 'رمز الحساب', 'Account Code'],
    ['field.account_name', 'field', 'اسم الحساب', 'Account Name'],
    ['field.account_type', 'field', 'نوع الحساب', 'Account Type'],
    ['field.normal_balance', 'field', 'الطبيعة المحاسبية', 'Normal Balance'],
    ['field.parent_account', 'field', 'الحساب الأب', 'Parent Account'],
    ['field.is_postable', 'field', 'قابل للترحيل', 'Postable'],
    ['field.is_contra', 'field', 'حساب مقابل', 'Contra Account'],
    ['field.control_function', 'field', 'وظيفة الحساب الرقابي', 'Control Function'],
    ['field.currency_mode', 'field', 'وضع العملة', 'Currency Mode'],
    ['field.restrict_currency', 'field', 'العملة المقيَّدة', 'Restricted Currency'],
    ['field.allow_manual_journal', 'field', 'يسمح بقيد يدوي', 'Allow Manual Journal'],
    ['field.dimension_rule_mode', 'field', 'وضع قاعدة البُعد', 'Dimension Rule Mode'],
    ['field.default_dimension_value', 'field', 'قيمة البُعد الافتراضية', 'Default Dimension Value'],
    ['value.account_type.asset', 'field', 'أصول', 'Asset'],
    ['value.account_type.liability', 'field', 'خصوم', 'Liability'],
    ['value.account_type.equity', 'field', 'حقوق ملكية', 'Equity'],
    ['value.account_type.revenue', 'field', 'إيرادات', 'Revenue'],
    ['value.account_type.expense', 'field', 'مصروفات', 'Expense'],
    ['value.normal_balance.debit', 'field', 'مدين', 'Debit'],
    ['value.normal_balance.credit', 'field', 'دائن', 'Credit'],
    ['value.currency_mode.functional_only', 'field', 'العملة الوظيفية فقط', 'Functional Currency Only'],
    ['value.currency_mode.single_foreign', 'field', 'عملة أجنبية واحدة', 'Single Foreign Currency'],
    ['value.currency_mode.any', 'field', 'أي عملة', 'Any Currency'],
    ['value.dimension_rule_mode.required', 'field', 'إلزامي', 'Required'],
    ['value.dimension_rule_mode.optional', 'field', 'اختياري', 'Optional'],
    ['value.dimension_rule_mode.blocked', 'field', 'محظور', 'Blocked'],
    ['action.add_account', 'field', 'إضافة حساب', 'Add Account'],
    ['action.add_child_account', 'field', 'إضافة حساب فرعي', 'Add Sub-Account'],
    ['action.reparent_account', 'field', 'نقل الحساب', 'Move Account'],
    ['action.assign_control_function', 'field', 'تعيين وظيفة رقابية', 'Assign Control Function'],
    ['action.import_starter_chart', 'field', 'استيراد دليل حسابات مبدئي', 'Import Starter Chart'],
    ['action.deactivate_account', 'field', 'إلغاء تنشيط الحساب', 'Deactivate Account'],
    ['action.activate_account', 'field', 'تنشيط الحساب', 'Activate Account'],
    ['panel.no_accounts_yet', 'field', 'لا توجد حسابات بعد', 'No accounts yet'],
    ['panel.chart_is_empty_import_hint', 'field', 'دليل الحسابات فارغ — يمكنك استيراد دليل مبدئي أو إضافة الحسابات يدويًا', 'The chart is empty — import a starter chart or add accounts manually'],
    ['panel.account_dimension_rules', 'field', 'قواعد الأبعاد المالية للحساب', 'Account Dimension Rules'],
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
