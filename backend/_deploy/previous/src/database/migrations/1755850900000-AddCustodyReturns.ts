import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Returns Engine Phase B (CTO directive — "مرتجعات الشحن") — extends the
 * SAME `return_requests` table Phase A already built (no new entity, no new
 * Process Engine, one unified Return Engine) with an `origin` discriminator
 * so a return can now also be a pre-delivery custody reversal from a
 * Shipping Company's or a Company Vehicle's custody, not just a customer
 * return. No new numbering sequence — custody returns reuse the existing
 * `'return'`/`RET` series.
 */
export class AddCustodyReturns1755850900000 implements MigrationInterface {
  name = 'AddCustodyReturns1755850900000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['return_origin.customer', 'field', 'مرتجع عميل', 'Customer Return'],
    ['return_origin.shipping_company_custody', 'field', 'مرتجع من عهدة شركة شحن', 'Shipping Company Custody Return'],
    ['return_origin.vehicle_custody', 'field', 'مرتجع من عهدة سيارة', 'Vehicle Custody Return'],
    ['field.return_origin', 'field', 'مصدر المرتجع', 'Return Origin'],
    ['field.custodian', 'field', 'الجهة الحائزة', 'Custodian'],
    ['field.custody_status', 'field', 'حالة العهدة', 'Current Custody Status'],
    ['panel.custody_returns', 'panel', 'مرتجعات الشحن (شركات الشحن / السيارات)', 'Shipping & Vehicle Custody Returns'],
    ['action.initiate_custody_return', 'action', 'بدء مرتجع عهدة', 'Initiate Custody Return'],
    ['action.search', 'action', 'بحث', 'Search'],
    ['field.waybill_number', 'field', 'رقم بوليصة الشحن', 'Waybill No.'],
    ['field.rsh_number', 'field', 'رقم أمر الشحن (RSH)', 'RSH No.'],
    ['field.customer_code', 'field', 'كود العميل', 'Customer Code'],
    ['panel.no_custody_results', 'panel', 'لا توجد نتائج مطابقة', 'No matching results'],
    ['nav.custody_returns', 'nav', 'مرتجعات الشحن', 'Custody Returns'],
    [
      'error.custody_return_after_collection',
      'field',
      'تم تحصيل قيمة الشحنة (COD) بالفعل — لا يمكن إجراء مرتجع عهدة تلقائيًا، يتطلب تسوية مالية يدوية.',
      'This shipment already has a COD collection recorded — a custody return after collection requires manual finance reconciliation.',
    ],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "return_requests" ADD COLUMN "origin" VARCHAR(32) NOT NULL DEFAULT 'customer'`);
    await queryRunner.query(`CREATE INDEX "IDX_return_requests_origin" ON "return_requests" ("origin")`);
    await queryRunner.query(`ALTER TABLE "return_requests" ADD COLUMN "shipmentId" UUID`);
    await queryRunner.query(`CREATE INDEX "IDX_return_requests_shipmentId" ON "return_requests" ("shipmentId")`);
    await queryRunner.query(`ALTER TABLE "return_requests" ADD COLUMN "custodianType" VARCHAR(16)`);
    await queryRunner.query(`ALTER TABLE "return_requests" ADD COLUMN "custodianId" UUID`);
    await queryRunner.query(`CREATE INDEX "IDX_return_requests_custodianId" ON "return_requests" ("custodianId")`);

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
    await queryRunner.query(`DROP INDEX "IDX_return_requests_custodianId"`);
    await queryRunner.query(`ALTER TABLE "return_requests" DROP COLUMN "custodianId"`);
    await queryRunner.query(`ALTER TABLE "return_requests" DROP COLUMN "custodianType"`);
    await queryRunner.query(`DROP INDEX "IDX_return_requests_shipmentId"`);
    await queryRunner.query(`ALTER TABLE "return_requests" DROP COLUMN "shipmentId"`);
    await queryRunner.query(`DROP INDEX "IDX_return_requests_origin"`);
    await queryRunner.query(`ALTER TABLE "return_requests" DROP COLUMN "origin"`);
  }
}
