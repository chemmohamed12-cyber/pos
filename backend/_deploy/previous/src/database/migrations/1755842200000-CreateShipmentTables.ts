import { MigrationInterface, QueryRunner } from 'typeorm';

/** Shipment + Tracking — Stage 2 build-order items 29-30. */
export class CreateShipmentTables1755842200000 implements MigrationInterface {
  name = 'CreateShipmentTables1755842200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "shipments" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "fulfillmentOrderId" VARCHAR(255) NOT NULL,
        "waybillNumber" VARCHAR(32) NOT NULL,
        "driverUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_shipments_waybillNumber" ON "shipments" ("waybillNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_shipments_fulfillmentOrderId" ON "shipments" ("fulfillmentOrderId")`);

    await queryRunner.query(`
      CREATE TABLE "tracking_events" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "shipmentId" UUID NOT NULL REFERENCES "shipments"("id") ON DELETE CASCADE,
        "eventType" VARCHAR(64) NOT NULL,
        "detail" VARCHAR(500),
        "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_tracking_events_shipmentId" ON "tracking_events" ("shipmentId")`);

    await queryRunner.query(
      `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear") VALUES ('shipment', 'WB', true)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "numbering_sequences" WHERE "documentType" = 'shipment'`);
    await queryRunner.query(`DROP TABLE "tracking_events"`);
    await queryRunner.query(`DROP TABLE "shipments"`);
  }
}
