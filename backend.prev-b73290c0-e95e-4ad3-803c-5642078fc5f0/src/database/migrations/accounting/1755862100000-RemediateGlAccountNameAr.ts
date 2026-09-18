import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chart of Accounts Arabic Data Remediation (CTO directive, 2026-09-13) — pure data correction, NOT a
 * Chart rebuild. `1755860200000-AddGlAccountNameAr` added the `nameAr` column AFTER the Starter Chart
 * had already been imported in every existing installation (including `daii_dev`), so every
 * previously-imported account's `nameAr` stayed `NULL` — the column existed, but nothing ever
 * backfilled it. This migration backfills `nameAr` ONLY, by `code`, sourced from the exact same
 * `ifrs-sme.template.ts` values a FRESH installation gets today (the template itself was corrected in
 * the same change as this migration — see git history / `EXCEL_IMPORT_AND_CHART_REVIEW.md` Part III §J
 * for the 5 wording corrections: codes 2/21/22 aligned to F14's own already-canonical
 * `field.section_liabilities` term; 4120/59 set to the CTO's own explicitly specified wording).
 *
 * Touches `nameAr` and NOTHING else — `code`, `id`, `parentAccountId`, `accountType`, `normalBalance`,
 * `isContra`, `isPostable`, `controlFunction`, and every other column are untouched by every statement
 * below (verified: none of them appear in any `SET` clause). `WHERE code = ? AND "nameAr" IS NULL` makes
 * every statement idempotent and safe to re-run — a re-run is a no-op, and an account someone already
 * gave a custom `nameAr` via the edit UI in the meantime is never overwritten. Applies to every
 * installation whose Starter Chart predates the `nameAr` column, not only `daii_dev` — the same gap
 * exists wherever this template was imported before this fix landed.
 */
export class RemediateGlAccountNameAr1755862100000 implements MigrationInterface {
  name = 'RemediateGlAccountNameAr1755862100000';

  private readonly nameArByCode: Array<[string, string]> = [
    ['1', 'الأصول'],
    ['11', 'الأصول المتداولة'],
    ['1101', 'النقدية بالصندوق'],
    ['1102', 'البنك — الحساب الجاري'],
    ['1110', 'العملاء (المدينون)'],
    ['1120', 'المخزون'],
    ['1130', 'مصروفات مدفوعة مقدمًا'],
    ['1140', 'ضريبة القيمة المضافة — المشتريات'],
    ['12', 'الأصول غير المتداولة'],
    ['1201', 'الممتلكات والآلات والمعدات'],
    ['1202', 'مجمع الإهلاك'],
    ['1210', 'الأصول غير الملموسة'],
    ['2', 'الالتزامات'],
    ['21', 'الالتزامات المتداولة'],
    ['2101', 'الموردون (الدائنون)'],
    ['2110', 'مصروفات مستحقة'],
    ['2120', 'ضريبة القيمة المضافة — المبيعات'],
    ['2130', 'قروض قصيرة الأجل'],
    ['22', 'الالتزامات غير المتداولة'],
    ['2201', 'قروض طويلة الأجل'],
    ['3', 'حقوق الملكية'],
    ['3101', 'رأس المال'],
    ['3102', 'الأرباح المحتجزة'],
    ['3103', 'نتيجة العام الحالي'],
    ['3110', 'مسحوبات المالك'],
    ['4', 'الإيرادات'],
    ['4101', 'إيرادات المبيعات'],
    ['4102', 'إيرادات الخدمات'],
    ['4110', 'مردودات ومسموحات المبيعات'],
    ['4120', 'خصومات المبيعات'],
    ['4900', 'إيرادات أخرى'],
    ['4910', 'أرباح / (خسائر) فروق العملة'],
    ['5', 'المصروفات'],
    ['51', 'تكلفة المبيعات'],
    ['5101', 'تكلفة البضاعة المباعة'],
    ['5110', 'مصروفات نقل المشتريات'],
    ['52', 'المصروفات التشغيلية'],
    ['5201', 'الرواتب والأجور'],
    ['5202', 'مصروف الإيجار'],
    ['5203', 'مصروفات المرافق'],
    ['5204', 'مصروف الإهلاك'],
    ['5205', 'التسويق والإعلان'],
    ['5206', 'أدوات ومستلزمات مكتبية'],
    ['5207', 'أتعاب مهنية'],
    ['5208', 'مصروفات بنكية'],
    ['5299', 'مصروفات متنوعة'],
    ['59', 'المصروفات الأخرى'],
    ['5901', 'فروق التقريب'],
    ['5902', 'مصروف الفوائد'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, nameAr] of this.nameArByCode) {
      await queryRunner.query(
        `UPDATE "accounting_gl_accounts" SET "nameAr" = $1 WHERE "code" = $2 AND "nameAr" IS NULL`,
        [nameAr, code],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverts to NULL only for the exact codes this migration itself would have set — never touches an
    // account whose nameAr was set some other way (e.g. hand-edited via the UI after this migration ran).
    for (const [code, nameAr] of this.nameArByCode) {
      await queryRunner.query(
        `UPDATE "accounting_gl_accounts" SET "nameAr" = NULL WHERE "code" = $1 AND "nameAr" = $2`,
        [code, nameAr],
      );
    }
  }
}
