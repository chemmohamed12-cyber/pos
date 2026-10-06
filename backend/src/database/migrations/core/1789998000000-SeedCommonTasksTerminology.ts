import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NAV-05 (2026-10-06) — "Common tasks" shortcuts to operations that live inside other screens: a label and a one-line "where is the action" hint each.
 * Idempotent seed; every text <= 255 characters.
 */
export class SeedCommonTasksTerminology1789998000000 implements MigrationInterface {
  name = 'SeedCommonTasksTerminology1789998000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['panel.common_tasks_title', 'panel', 'مهام شائعة — أين أجدها؟', 'Common tasks — where to find them'],
    ['task.goods_receipt.label', 'panel', 'استلام بضاعة', 'Goods receipt'],
    ['task.goods_receipt.where', 'panel', 'أوامر الشراء ← افتح أمر شراء معتمدًا ← استلام البضاعة', 'Purchase orders → open an approved PO → receive goods'],
    ['task.supplier_payment.label', 'panel', 'سداد مورد', 'Supplier payment'],
    ['task.supplier_payment.where', 'panel', 'فواتير الموردين ← افتح الفاتورة ← سداد', 'Supplier invoices → open the invoice → pay'],
    ['task.customer_payment.label', 'panel', 'تحصيل من عميل', 'Customer payment'],
    ['task.customer_payment.where', 'panel', 'حسابات العملاء ← افتح حساب العميل ← تسجيل دفعة على فاتورة', 'Customer accounts → open the customer → record a payment against an invoice'],
    ['task.on_account_payment.label', 'panel', 'دفعة على الحساب', 'On-account payment'],
    ['task.on_account_payment.where', 'panel', 'حسابات العملاء ← افتح حساب العميل ← دفعة على الحساب (بدون فاتورة)', 'Customer accounts → open the customer → on-account payment (no invoice)'],
    ['task.invoice_creation.label', 'panel', 'إنشاء فاتورة بيع', 'Create a sales invoice'],
    ['task.invoice_creation.where', 'panel', 'حسابات العملاء ← افتح حساب العميل ← فاتورة جديدة من أمر بيع', 'Customer accounts → open the customer → new invoice from a sales order'],
    ['task.deposit.label', 'panel', 'عربون أمر البيع', 'Sales order deposit'],
    ['task.deposit.where', 'panel', 'أوامر البيع ← افتح الأمر ← لوحة العربون', 'Sales orders → open the order → deposit panel'],
    ['task.treasury_actions.label', 'panel', 'حركات الخزينة', 'Treasury actions'],
    ['task.treasury_actions.where', 'panel', 'دفتر الخزينة ← إيداع نقدي / صرف نقدي / تحويل / عكس حركة', 'Treasury ledger → cash in / cash out / transfer / reverse a transaction'],
    ['task.new_item_request.label', 'panel', 'طلب صنف جديد', 'New item request'],
    ['task.new_item_request.where', 'panel', 'طلبات الشراء ← قسم طلبات الأصناف الجديدة', 'Purchase requests → new item requests section'],
    ['task.opening_stock.label', 'panel', 'رصيد افتتاحي للمخزون', 'Opening stock'],
    ['task.opening_stock.where', 'panel', 'المخزون ← استيراد الرصيد الافتتاحي (ملف Excel)', 'Inventory → opening stock import (Excel file)'],
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
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
