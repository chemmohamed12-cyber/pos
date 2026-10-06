import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NAV-05 (2026-10-06) — correction found by the browser verification of the "Common tasks" hints (migration 1789998000000):
 *  - customer payment / on-account payment / invoice creation live under the customer account's "Invoices" tab, not on its first tab;
 *  - the deposit panel is shown only for an order at the deposit-verification stage (or one that already has a deposit).
 * Idempotent upsert; every text <= 255 characters.
 */
export class RefineCommonTasksHints1790001000000 implements MigrationInterface {
  name = 'RefineCommonTasksHints1790001000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['task.customer_payment.where', 'panel', 'حسابات العملاء ← افتح حساب العميل ← تبويب الفواتير ← تسجيل دفعة على فاتورة', 'Customer accounts → open the customer → Invoices tab → record a payment against an invoice'],
    ['task.on_account_payment.where', 'panel', 'حسابات العملاء ← افتح حساب العميل ← تبويب الفواتير ← دفعة على الحساب (بدون فاتورة)', 'Customer accounts → open the customer → Invoices tab → on-account payment (no invoice)'],
    ['task.invoice_creation.where', 'panel', 'حسابات العملاء ← افتح حساب العميل ← تبويب الفواتير ← إنشاء فاتورة من أمر بيع', 'Customer accounts → open the customer → Invoices tab → create an invoice from a sales order'],
    ['task.deposit.where', 'panel', 'أوامر البيع ← افتح أمرًا في مرحلة التحقق من العربون (أو له عربون) ← لوحة العربون', 'Sales orders → open an order at deposit verification (or one with a deposit) → deposit panel'],
  ];

  /** The wording of migration 1789998000000, restored by `down`. */
  private readonly previous: Array<[string, string, string]> = [
    ['task.customer_payment.where', 'حسابات العملاء ← افتح حساب العميل ← تسجيل دفعة على فاتورة', 'Customer accounts → open the customer → record a payment against an invoice'],
    ['task.on_account_payment.where', 'حسابات العملاء ← افتح حساب العميل ← دفعة على الحساب (بدون فاتورة)', 'Customer accounts → open the customer → on-account payment (no invoice)'],
    ['task.invoice_creation.where', 'حسابات العملاء ← افتح حساب العميل ← فاتورة جديدة من أمر بيع', 'Customer accounts → open the customer → new invoice from a sales order'],
    ['task.deposit.where', 'أوامر البيع ← افتح الأمر ← لوحة العربون', 'Sales orders → open the order → deposit panel'],
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
    for (const [code, ar, en] of this.previous) {
      await queryRunner.query(`UPDATE "terminology_entries" SET "ar" = $2, "en" = $3, "version" = "version" + 1 WHERE code = $1`, [code, ar, en]);
    }
  }
}
