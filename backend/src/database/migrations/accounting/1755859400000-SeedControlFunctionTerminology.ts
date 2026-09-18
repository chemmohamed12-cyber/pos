import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `accounting`-tagged (ADR-025). CTO directive (2026-09-12) — the Chart of
 * Accounts tree was rendering `(header)` (a hardcoded English literal) and
 * `[retained_earnings]`/`[fx_gain_loss]`/etc. (the raw backend
 * `ControlFunction` enum value, RBW-confirmed against
 * `domains/accounting/domain/control-function.ts`'s own `CONTROL_FUNCTIONS`
 * list) with no `t()` call at all — this seeds the terminology these two
 * spots now actually resolve (`ChartOfAccounts.tsx`'s `TreeView`), closing
 * the data-completeness gap alongside the `TerminologyService` Arabic-first
 * fallback fix (same directive).
 */
export class SeedControlFunctionTerminology1755859400000 implements MigrationInterface {
  name = 'SeedControlFunctionTerminology1755859400000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['label.header_account', 'field', 'حساب رئيسي', 'Header'],
    ['value.control_function.ar', 'field', 'الذمم المدينة', 'Accounts Receivable'],
    ['value.control_function.ap', 'field', 'الذمم الدائنة', 'Accounts Payable'],
    ['value.control_function.bank', 'field', 'البنك', 'Bank'],
    ['value.control_function.inventory', 'field', 'المخزون', 'Inventory'],
    ['value.control_function.tax_payable', 'field', 'ضريبة مستحقة الدفع', 'Tax Payable'],
    ['value.control_function.tax_receivable', 'field', 'ضريبة قابلة للاسترداد', 'Tax Receivable'],
    ['value.control_function.retained_earnings', 'field', 'الأرباح المحتجزة', 'Retained Earnings'],
    ['value.control_function.fx_gain_loss', 'field', 'أرباح/خسائر فروق العملة', 'FX Gain/Loss'],
    ['value.control_function.rounding', 'field', 'فروق التقريب', 'Rounding'],
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
