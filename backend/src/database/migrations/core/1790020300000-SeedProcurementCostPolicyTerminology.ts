import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Owner decisions 2026-10-20 (E1 / E3): three NEW, separately configured GL accounts - never mixed with the purchase price variance account and never defaulted:
 *  - purchase cost differences after receipt (discounts / capitalisable charges that reach units already sold or consumed),
 *  - supplier return cost differences (book cost of goods returned vs the value credited by the supplier),
 *  - non-capitalisable purchase charges (expensed).
 * Terminology only; the keys themselves live in the accounting manifest. `down` removes exactly these rows.
 */
export class SeedProcurementCostPolicyTerminology1790020300000 implements MigrationInterface {
  name = 'SeedProcurementCostPolicyTerminology1790020300000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['policy.purchase_cost_difference_after_receipt_account_code.label', 'field', 'حساب فروق تكلفة المشتريات بعد الاستلام', 'Purchase cost differences after receipt account'],
    ['policy.purchase_cost_difference_after_receipt_account_code.help', 'panel', 'يستقبل نصيب الخصومات والشحن المرسمل من فاتورة المورد الذي يخص وحدات سبق بيعها أو استهلاكها بعد الاستلام. يُخصّص من المسؤول المالي ولا يُستخدم لفروق الأسعار.', 'Receives the share of supplier-invoice discounts and capitalised freight that belongs to units already sold or consumed after receipt. Assigned by the finance owner; never used for price variances.'],
    ['policy.purchase_return_cost_difference_account_code.label', 'field', 'حساب فروق تكلفة مردودات الموردين', 'Supplier return cost differences account'],
    ['policy.purchase_return_cost_difference_account_code.help', 'panel', 'يستقبل الفرق بين القيمة الدفترية للبضاعة المرتجعة للمورد (متوسط التكلفة وقت الإرجاع) والقيمة المعتمدة في مردود المورد أو الإشعار الدائن. لا يُخلط بفروق الجرد.', 'Receives the difference between the book value of goods returned to a supplier (moving average at return time) and the value approved on the supplier return or credit note. Not mixed with stock-count differences.'],
    ['policy.purchase_return_clearing_account_code.label', 'field', 'حساب مردودات الموردين بانتظار الإشعار الدائن', 'Supplier returns pending credit account'],
    ['policy.purchase_return_clearing_account_code.help', 'panel', 'يحمل القيمة الدفترية للبضاعة المفوترة التي أُرجعت فعليًا للمورد إلى أن يُرحَّل الإشعار الدائن الذي يسوّيها؛ لا يُخفَّض حساب الموردين عند المرتجع المادي.', 'Holds the book value of INVOICED goods physically returned to the supplier until the credit note that settles them is posted; Accounts payable is not reduced by the physical return.'],
    ['policy.purchase_other_charges_account_code.label', 'field', 'حساب مصروفات المشتريات (شحن ومصاريف غير مرسملة)', 'Purchase Charges Expensed account'],
    ['policy.purchase_other_charges_account_code.help', 'panel', 'يستقبل الشحن والتكاليف الإضافية في فاتورة المورد التي لا تُرسمل على المخزون. عادةً حساب مصروف.', 'Receives supplier-invoice freight and other charges that are not capitalised into inventory. Typically an expense account.'],
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
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1::text[])`, [this.rows.map(([code]) => code)]);
  }
}
