import { MigrationInterface, QueryRunner } from 'typeorm';

/** Terminology for the printing architecture (CTO finalization directive §5-7). */
export class SeedPrintDocumentTerminology1755844200000 implements MigrationInterface {
  name = 'SeedPrintDocumentTerminology1755844200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['document.sales_order_title', 'document', 'أمر بيع', 'Sales Order'],
      ['document.waybill_title', 'document', 'بوليصة شحن', 'Waybill'],
      ['document.deposit_receipt_title', 'document', 'إيصال عربون', 'Deposit Receipt'],
      ['document.pick_list_title', 'document', 'إذن تجهيز', 'Pick List'],
      ['document.pack_list_title', 'document', 'إذن تعبئة', 'Pack List'],
      ['document.delivery_title', 'document', 'إذن تسليم', 'Delivery Note'],
      ['document.return_title', 'document', 'إذن مرتجع', 'Return Note'],
      ['document.movement_title', 'document', 'إذن حركة مخزون', 'Inventory Movement'],
      ['document.customer_title', 'document', 'بيانات العميل', 'Customer Profile'],
      ['document.price_list_title', 'document', 'قائمة الأسعار', 'Price List'],
      ['action.print', 'action', 'طباعة', 'Print'],
      ['delivery_outcome.delivered', 'delivery_outcome', 'تم التسليم', 'Delivered'],
      ['delivery_outcome.failed', 'delivery_outcome', 'فشل التسليم', 'Failed'],
      ['delivery_outcome.refused', 'delivery_outcome', 'رفض الاستلام', 'Refused'],
      ['delivery_outcome.returned', 'delivery_outcome', 'مرتجع', 'Returned'],
    ];

    for (const [code, category, ar, en] of seed) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const codes = [
      'document.sales_order_title', 'document.waybill_title', 'document.deposit_receipt_title',
      'document.pick_list_title', 'document.pack_list_title', 'document.delivery_title',
      'document.return_title', 'document.movement_title', 'document.customer_title', 'document.price_list_title',
      'action.print', 'delivery_outcome.delivered', 'delivery_outcome.failed', 'delivery_outcome.refused', 'delivery_outcome.returned',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
