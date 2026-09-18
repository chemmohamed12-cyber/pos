import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO directive §2 — "شحن أثناء إنشاء Sales Order" (shipping method chosen
 * at order creation: company vehicles vs. shipping company), shown on the
 * redesigned SO header. Nullable column — pre-existing orders degrade to
 * null/— (same precedent as `sales_orders.createdByUserId`), required at
 * the application layer for every new order.
 */
export class AddSalesOrderShippingMethod1755850500000 implements MigrationInterface {
  name = 'AddSalesOrderShippingMethod1755850500000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['field.shipping_method', 'field', 'طريقة الشحن', 'Shipping Method'],
    ['shipping_method.company_vehicles', 'field', 'سيارات الشركة', 'Company Vehicles'],
    ['shipping_method.shipping_company', 'field', 'شركة شحن', 'Shipping Company'],
    ['field.governorate', 'field', 'المحافظة', 'Governorate'],
    ['field.address', 'field', 'العنوان', 'Address'],
    ['field.deposit_status', 'field', 'حالة العربون', 'Deposit Status'],
    ['action.delete', 'action', 'حذف', 'Delete'],
    ['panel.confirm_delete_draft', 'panel', 'هل تريد حذف هذا الأمر (مسودة)؟ لا يمكن التراجع عن هذا الإجراء.', 'Delete this draft order? This action cannot be undone.'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_orders" ADD COLUMN "shippingMethod" VARCHAR(20)`);
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
    await queryRunner.query(
      `DELETE FROM "terminology_entries" WHERE code = ANY($1)`,
      [this.terminology.map(([code]) => code)],
    );
    await queryRunner.query(`ALTER TABLE "sales_orders" DROP COLUMN "shippingMethod"`);
  }
}
