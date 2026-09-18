import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F01 — Financial Foundation (ADR-032). `accounting`-tagged (ADR-025) —
 * every string the `accounting` frontend pages render comes from the
 * Terminology Registry, same rule as every other module (ADR-011).
 */
export class SeedAccountingTerminology1755854500000 implements MigrationInterface {
  name = 'SeedAccountingTerminology1755854500000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['module.accounting', 'field', 'المحاسبة', 'Accounting'],
    ['nav.accounting_settings', 'field', 'إعدادات المحاسبة', 'Accounting Settings'],
    ['field.currency_code', 'field', 'رمز العملة', 'Currency Code'],
    ['field.currency_name', 'field', 'اسم العملة', 'Currency Name'],
    ['field.symbol', 'field', 'الرمز', 'Symbol'],
    ['field.is_base_currency', 'field', 'العملة الأساسية', 'Base Currency'],
    ['field.rate_date', 'field', 'تاريخ السعر', 'Rate Date'],
    ['field.rate', 'field', 'السعر', 'Rate'],
    ['field.rate_source', 'field', 'مصدر السعر', 'Rate Source'],
    ['field.fiscal_year', 'field', 'السنة المالية', 'Fiscal Year'],
    ['field.fiscal_period', 'field', 'الفترة المالية', 'Fiscal Period'],
    ['field.start_date', 'field', 'تاريخ البداية', 'Start Date'],
    ['field.end_date', 'field', 'تاريخ النهاية', 'End Date'],
    ['field.tax_code', 'field', 'رمز الضريبة', 'Tax Code'],
    ['field.is_inclusive', 'field', 'شامل الضريبة', 'Tax Inclusive'],
    ['field.dimension_type', 'field', 'نوع البُعد المالي', 'Dimension Type'],
    ['field.dimension_value', 'field', 'قيمة البُعد المالي', 'Dimension Value'],
    ['action.set_base_currency', 'field', 'تعيين كعملة أساسية', 'Set as Base Currency'],
    ['action.activate_fiscal_year', 'field', 'تفعيل السنة المالية', 'Activate Fiscal Year'],
    ['action.close_fiscal_year', 'field', 'إغلاق السنة المالية', 'Close Fiscal Year'],
    ['action.reopen_fiscal_period', 'field', 'إعادة فتح الفترة المالية', 'Reopen Fiscal Period'],
    ['panel.no_currencies_yet', 'field', 'لا توجد عملات بعد', 'No currencies yet'],
    ['panel.no_fiscal_years_yet', 'field', 'لا توجد سنوات مالية بعد', 'No fiscal years yet'],
    ['panel.no_tax_codes_yet', 'field', 'لا توجد رموز ضريبية بعد', 'No tax codes yet'],
    ['panel.no_dimensions_yet', 'field', 'لا توجد أبعاد مالية بعد', 'No financial dimensions yet'],
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
