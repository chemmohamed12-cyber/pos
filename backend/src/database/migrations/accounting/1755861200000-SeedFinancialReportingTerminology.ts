import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F14 — Financial Reporting (ADR-047). Same convention as `SeedGeneralLedgerTerminology1755854900000` —
 * every string the F14 frontend renders comes from the Terminology Registry (ADR-011). No schema
 * change — this migration only seeds `terminology_entries` rows.
 */
export class SeedFinancialReportingTerminology1755861200000 implements MigrationInterface {
  name = 'SeedFinancialReportingTerminology1755861200000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['nav.balance_sheet', 'field', 'الميزانية العمومية', 'Balance Sheet'],
    ['nav.profit_and_loss', 'field', 'قائمة الدخل', 'Profit and Loss'],
    ['nav.cash_flow', 'field', 'قائمة التدفقات النقدية', 'Cash Flow Statement'],
    ['field.as_of_date', 'field', 'كما في تاريخ', 'As of Date'],
    ['field.from_date', 'field', 'من تاريخ', 'From'],
    ['field.to_date', 'field', 'إلى تاريخ', 'To'],
    ['field.section_assets', 'field', 'الأصول', 'Assets'],
    ['field.section_liabilities', 'field', 'الالتزامات', 'Liabilities'],
    ['field.section_equity', 'field', 'حقوق الملكية', 'Equity'],
    ['field.section_revenue', 'field', 'الإيرادات', 'Revenue'],
    ['field.section_expenses', 'field', 'المصروفات', 'Expenses'],
    ['field.unclosed_net_income', 'field', 'صافي الدخل غير المُقفل (محسوب)', 'Unclosed Net Income (computed)'],
    ['field.net_income', 'field', 'صافي الدخل', 'Net Income'],
    ['field.total_assets', 'field', 'إجمالي الأصول', 'Total Assets'],
    ['field.total_liabilities', 'field', 'إجمالي الالتزامات', 'Total Liabilities'],
    ['field.total_equity', 'field', 'إجمالي حقوق الملكية', 'Total Equity'],
    ['field.total_revenue', 'field', 'إجمالي الإيرادات', 'Total Revenue'],
    ['field.total_expenses', 'field', 'إجمالي المصروفات', 'Total Expenses'],
    ['field.beginning_cash', 'field', 'النقدية أول المدة', 'Beginning Cash'],
    ['field.ending_cash', 'field', 'النقدية آخر المدة', 'Ending Cash'],
    ['field.net_change_in_cash', 'field', 'صافي التغير في النقدية', 'Net Change in Cash'],
    ['field.operating_activities', 'field', 'الأنشطة التشغيلية', 'Operating Activities'],
    ['field.investing_activities', 'field', 'الأنشطة الاستثمارية', 'Investing Activities'],
    ['field.financing_activities', 'field', 'الأنشطة التمويلية', 'Financing Activities'],
    ['field.depreciation_addback', 'field', 'إضافة الإهلاك', 'Depreciation Add-back'],
    ['field.ar_movement', 'field', 'حركة الذمم المدينة', 'AR Movement'],
    ['field.ap_movement', 'field', 'حركة الذمم الدائنة', 'AP Movement'],
    ['field.inventory_movement', 'field', 'حركة المخزون', 'Inventory Movement'],
    ['field.acquisitions_cash_outflow', 'field', 'مدفوعات اقتناء الأصول', 'Acquisitions (Cash Out)'],
    ['field.disposals_cash_inflow', 'field', 'متحصلات استبعاد الأصول', 'Disposals (Cash In)'],
    ['field.unclassified_other', 'field', 'غير مصنّف / أخرى (تسوية)', 'Unclassified / Other (reconciling)'],
    ['panel.balanced', 'field', '✓ متوازنة', '✓ balanced'],
    ['panel.not_balanced', 'field', '✗ غير متوازنة — يلزم المراجعة', '✗ NOT balanced — investigate'],
    [
      'note.cash_flow_investing_limitation',
      'field',
      'الأنشطة الاستثمارية تشمل عمليات اقتناء/استبعاد الأصول الثابتة فقط — لا يوجد نوع آخر من الأنشطة الاستثمارية في هذا الإصدار من النظام.',
      'Investing activity covers fixed-asset acquisitions/disposals only — no other investing-transaction type is modeled in this system version.',
    ],
    [
      'note.cash_flow_financing_limitation',
      'field',
      'لا توجد عمليات تمويلية في هذا الإصدار من النظام.',
      'No financing transactions are modeled in this system version.',
    ],
    // NOTE: 'action.export_excel' already exists (core/1755844300000-SeedExcelTerminology.ts) — reused
    // as-is by the frontend, not re-seeded here.
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
