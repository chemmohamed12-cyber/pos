import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RSH Shipping Orders (CTO directive §3) — a Shipping Order is created
 * directly linked to its Sales Order the moment the order reaches
 * Ready-for-Shipping (i.e. when its Pack Task closes). Reuses the existing
 * `Shipment` entity/state machine (`created` = RSH exists, no carrier
 * assigned yet) rather than a new parallel one. All three columns nullable
 * — existing dev-DB shipments degrade to null/—, same precedent as every
 * other additive column in this codebase.
 */
export class AddShipmentRshNumberAndSalesOrderLink1755850700000 implements MigrationInterface {
  name = 'AddShipmentRshNumberAndSalesOrderLink1755850700000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['field.rsh_number', 'field', 'رقم أمر الشحن', 'Shipping Order Number'],
    ['field.shipping_order', 'field', 'أمر الشحن', 'Shipping Order'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shipments" ADD COLUMN "rshNumber" VARCHAR(32)`);
    await queryRunner.query(`ALTER TABLE "shipments" ADD COLUMN "salesOrderId" UUID`);
    await queryRunner.query(`ALTER TABLE "shipments" ADD COLUMN "salesOrderNumber" VARCHAR(32)`);
    await queryRunner.query(`CREATE INDEX "IDX_shipments_salesOrderId" ON "shipments" ("salesOrderId")`);
    await queryRunner.query(
      `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear") VALUES ('shipping_order', 'RSH', true) ON CONFLICT DO NOTHING`,
    );
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
    await queryRunner.query(`DELETE FROM "numbering_sequences" WHERE "documentType" = 'shipping_order'`);
    await queryRunner.query(`DROP INDEX "IDX_shipments_salesOrderId"`);
    await queryRunner.query(`ALTER TABLE "shipments" DROP COLUMN "salesOrderNumber"`);
    await queryRunner.query(`ALTER TABLE "shipments" DROP COLUMN "salesOrderId"`);
    await queryRunner.query(`ALTER TABLE "shipments" DROP COLUMN "rshNumber"`);
  }
}
