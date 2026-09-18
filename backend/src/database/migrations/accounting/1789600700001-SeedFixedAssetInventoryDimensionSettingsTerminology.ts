import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `accounting`-tagged (ADR-025). Frontend recovery/integration pass
 * (2026-09-17) — F07 (Inventory Accounting) and F12 (Fixed Assets) shipped
 * their backend + `value.control_function.fixed_asset` only; no frontend
 * page terminology was ever seeded for either (confirmed: neither
 * `nav.fixed_assets` nor `nav.inventory_accounting` exist anywhere in the
 * migration history). This seeds exactly what `FixedAssets.tsx` /
 * `InventoryAccounting.tsx` / `Dimensions.tsx` / `AccountingSettings.tsx`
 * need that ISN'T already covered by `SeedAccountingTerminology` /
 * `SeedChartOfAccountsTerminology` / `SeedGeneralLedgerTerminology` /
 * `SeedArTerminology(Extras)` / `SeedApTerminology` / `SeedCashBankTerminology`.
 * Same idempotent (`ON CONFLICT`) shape as every other terminology seed.
 */
export class SeedFixedAssetInventoryDimensionSettingsTerminology1789600700001 implements MigrationInterface {
  name = 'SeedFixedAssetInventoryDimensionSettingsTerminology1789600700001';

  private readonly terminology: Array<[string, string, string, string]> = [
    // Nav
    ['nav.fixed_assets', 'field', 'الأصول الثابتة', 'Fixed Assets'],
    ['nav.dimensions', 'field', 'الأبعاد المالية', 'Financial Dimensions'],
    ['nav.inventory_accounting', 'field', 'محاسبة المخزون', 'Inventory Accounting'],

    // Fixed Asset register fields
    ['field.asset_code', 'field', 'رمز الأصل', 'Asset Code'],
    ['field.asset_name', 'field', 'اسم الأصل', 'Asset Name'],
    ['field.asset_category', 'field', 'فئة الأصل', 'Asset Category'],
    ['field.acquisition_date', 'field', 'تاريخ الاقتناء', 'Acquisition Date'],
    ['field.cost', 'field', 'التكلفة', 'Cost'],
    ['field.salvage_value', 'field', 'القيمة المتبقية', 'Salvage Value'],
    ['field.useful_life_months', 'field', 'العمر الإنتاجي (أشهر)', 'Useful Life (Months)'],
    ['field.depreciation_method', 'field', 'طريقة الإهلاك', 'Depreciation Method'],
    ['field.depreciable_base', 'field', 'أساس الإهلاك', 'Depreciable Base'],
    ['field.cost_account', 'field', 'حساب التكلفة', 'Cost Account'],
    ['field.accumulated_depreciation_account', 'field', 'حساب مجمع الإهلاك', 'Accumulated Depreciation Account'],
    ['field.depreciation_expense_account', 'field', 'حساب مصروف الإهلاك', 'Depreciation Expense Account'],
    ['field.depreciation_period', 'field', 'فترة الإهلاك', 'Depreciation Period'],
    ['field.opening_net_book_value', 'field', 'صافي القيمة الدفترية الافتتاحية', 'Opening Net Book Value'],
    ['field.calculated_amount', 'field', 'المبلغ المحتسب', 'Calculated Amount'],
    ['field.resulting_net_book_value', 'field', 'صافي القيمة الدفترية الناتجة', 'Resulting Net Book Value'],
    ['field.disposal_date', 'field', 'تاريخ الاستبعاد', 'Disposal Date'],
    ['field.proceeds', 'field', 'المتحصلات', 'Proceeds'],
    ['field.proceeds_account', 'field', 'حساب المتحصلات', 'Proceeds Account'],
    ['field.gain_loss_amount', 'field', 'الربح/الخسارة', 'Gain / Loss'],
    ['value.depreciation_method.straight_line', 'field', 'القسط الثابت', 'Straight Line'],

    // Fixed Asset actions
    ['action.create_fixed_asset', 'field', 'إضافة أصل ثابت', 'Add Fixed Asset'],
    ['action.link_acquisition', 'field', 'ربط قيد الاقتناء', 'Link Acquisition Entry'],
    ['action.run_depreciation', 'field', 'تشغيل الإهلاك', 'Run Depreciation'],
    ['action.dispose_asset', 'field', 'استبعاد الأصل', 'Dispose Asset'],
    ['action.submit_fixed_asset_disposal', 'field', 'تقديم طلب استبعاد', 'Submit Disposal'],
    ['panel.no_fixed_assets_yet', 'field', 'لا توجد أصول ثابتة بعد', 'No fixed assets yet'],
    ['panel.no_depreciation_runs_yet', 'field', 'لا توجد عمليات إهلاك بعد', 'No depreciation runs yet'],
    ['panel.fixed_asset_disposal_submitted_approval', 'field', 'تم تقديم طلب الاستبعاد للاعتماد', 'Disposal submitted for approval'],

    // Inventory Accounting
    ['field.warehouse', 'field', 'المستودع', 'Warehouse'],
    ['field.counter_account_code', 'field', 'رمز الحساب المقابل', 'Counter Account Code'],
    ['value.inventory_adjustment_kind.physical_count_variance', 'field', 'فرق الجرد الفعلي', 'Physical Count Variance'],
    ['value.inventory_adjustment_kind.valuation_write_down', 'field', 'تخفيض قيمة المخزون', 'Valuation Write-down'],
    ['action.submit_inventory_adjustment', 'field', 'تقديم تسوية مخزون', 'Submit Inventory Adjustment'],
    ['panel.no_inventory_reconciliations_yet', 'field', 'لا توجد تسويات مخزون بعد', 'No inventory reconciliations yet'],
    ['panel.inventory_adjustment_submitted_approval', 'field', 'تم تقديم التسوية للاعتماد', 'Adjustment submitted for approval'],

    // Dimensions CRUD
    ['field.dimension_type_code', 'field', 'رمز نوع البُعد', 'Dimension Type Code'],
    ['field.dimension_value_code', 'field', 'رمز قيمة البُعد', 'Dimension Value Code'],
    ['action.create_dimension_type', 'field', 'إضافة نوع بُعد', 'Add Dimension Type'],
    ['action.create_dimension_value', 'field', 'إضافة قيمة بُعد', 'Add Dimension Value'],

    // Accounting Settings extras (currencies/fiscal years/tax codes/tax periods)
    ['field.rounding_mode', 'field', 'طريقة التقريب', 'Rounding Mode'],
    ['value.rounding_mode.half_up', 'field', 'تقريب لأعلى', 'Half Up'],
    ['value.rounding_mode.half_even', 'field', 'تقريب زوجي', 'Half Even'],
    ['value.rounding_mode.half_down', 'field', 'تقريب لأسفل', 'Half Down'],
    ['field.tax_period', 'field', 'الفترة الضريبية', 'Tax Period'],
    ['field.jurisdiction_code', 'field', 'رمز الولاية الضريبية', 'Jurisdiction Code'],
    ['field.fiscal_year_status', 'field', 'حالة السنة المالية', 'Fiscal Year Status'],
    ['field.fiscal_period_status', 'field', 'حالة الفترة المالية', 'Fiscal Period Status'],
    ['action.create_currency', 'field', 'إضافة عملة', 'Add Currency'],
    ['action.record_exchange_rate', 'field', 'تسجيل سعر صرف', 'Record Exchange Rate'],
    ['action.create_fiscal_year', 'field', 'إضافة سنة مالية', 'Add Fiscal Year'],
    ['action.create_tax_code', 'field', 'إضافة رمز ضريبي', 'Add Tax Code'],
    ['action.create_tax_period', 'field', 'إضافة فترة ضريبية', 'Add Tax Period'],
    ['action.deactivate_currency', 'field', 'إلغاء تنشيط العملة', 'Deactivate Currency'],
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
