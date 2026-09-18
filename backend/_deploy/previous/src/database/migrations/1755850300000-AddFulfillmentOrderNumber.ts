import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO directive (Fulfillment screen rework — order review before receiving,
 * one-click "تم التغليف وجاهز للشحن") — the Fulfillment Order gets its own
 * document number, same format/sequence discipline as the Sales Order
 * (`sales_order`/'SO', see CreateNumberingSequences1755841200000), just a
 * different two-letter prefix ('FO') so the two document series never collide.
 */
export class AddFulfillmentOrderNumber1755850300000 implements MigrationInterface {
  name = 'AddFulfillmentOrderNumber1755850300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "fulfillment_orders" ADD COLUMN "orderNumber" VARCHAR(32)`);
    await queryRunner.query(
      `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear") VALUES ('fulfillment_order', 'FO', true) ON CONFLICT DO NOTHING`,
    );
    const seed: Array<[string, string, string, string]> = [
      ['field.fulfillment_order_number', 'field', 'رقم أمر التجهيز', 'Fulfillment Order Number'],
      ['action.finish_packing_ready_for_shipping', 'action', 'تم التغليف وجاهز للشحن', 'Packing Done — Ready for Shipping'],
      ['panel.order_items_preview', 'panel', 'أصناف الأوردر', 'Order Items'],
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
      [['field.fulfillment_order_number', 'action.finish_packing_ready_for_shipping', 'panel.order_items_preview']],
    );
    await queryRunner.query(`DELETE FROM "numbering_sequences" WHERE "documentType" = 'fulfillment_order'`);
    await queryRunner.query(`ALTER TABLE "fulfillment_orders" DROP COLUMN "orderNumber"`);
  }
}
