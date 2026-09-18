import { MigrationInterface, QueryRunner } from 'typeorm';

/** CTO directive ("Shipping Company waybill-required flow") — blocks confirming dispatch to a shipping company without a carrier waybill number + image. */
export class AddShipmentCarrierWaybillFields1755850800000 implements MigrationInterface {
  name = 'AddShipmentCarrierWaybillFields1755850800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shipments" ADD COLUMN "carrierWaybillNumber" VARCHAR(64)`);
    await queryRunner.query(`ALTER TABLE "shipments" ADD COLUMN "waybillImageMediaAssetId" UUID`);

    const seed: Array<[string, string, string, string]> = [
      ['field.carrier_waybill_number', 'field', 'رقم بوليصة الشحن', 'Carrier Waybill Number'],
      ['field.waybill_image', 'field', 'صورة البوليصة', 'Waybill Image'],
      ['action.upload_waybill', 'action', 'رفع صورة البوليصة', 'Upload Waybill Image'],
      ['action.save_carrier_waybill', 'action', 'حفظ بيانات البوليصة', 'Save Waybill Details'],
      ['panel.carrier_waybill_required', 'panel', 'مطلوب بيانات بوليصة شركة الشحن قبل تأكيد الاستلام', 'Carrier waybill details are required before confirming pickup'],
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
    await queryRunner.query(
      `DELETE FROM "terminology_entries" WHERE code = ANY($1)`,
      [[
        'field.carrier_waybill_number',
        'field.waybill_image',
        'action.upload_waybill',
        'action.save_carrier_waybill',
        'panel.carrier_waybill_required',
      ]],
    );
    await queryRunner.query(`ALTER TABLE "shipments" DROP COLUMN "waybillImageMediaAssetId"`);
    await queryRunner.query(`ALTER TABLE "shipments" DROP COLUMN "carrierWaybillNumber"`);
  }
}
