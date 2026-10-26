import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vehicle Driver Workspace, Stage C / C2 (2026-10-22; D-1 approved by the CTO) - additive and append-only:
 * `shipment_line_deliveries` records, per shipment line, what the driver actually handed over (`delivered`) or brought back (`returned`). It adds NO shipment state (the canonical
 * state machine is untouched) and posts nothing (stock and AR effects of a short delivery stay with the existing delivery outcome and the Returns Engine). The invariant
 * delivered + returned <= shipped is enforced by the service under a per-shipment lock; the table itself only guarantees positive quantities and idempotent retries.
 * `down` drops the table (the event history is lost - forward-fix once it is in use).
 */
export class CreateShipmentLineDeliveries1790040100000 implements MigrationInterface {
  name = 'CreateShipmentLineDeliveries1790040100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shipment_line_deliveries" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "shipmentId" UUID NOT NULL,
        "shipmentLineId" UUID NOT NULL,
        "kind" VARCHAR(16) NOT NULL,
        "quantity" INT NOT NULL,
        "reason" VARCHAR(255),
        "recordedByUserId" UUID NOT NULL,
        "clientKey" VARCHAR(64),
        "recordedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_shipment_line_deliveries_kind" CHECK ("kind" IN ('delivered','returned')),
        CONSTRAINT "CHK_shipment_line_deliveries_qty" CHECK ("quantity" > 0)
      )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_shipment_line_deliveries_shipment" ON "shipment_line_deliveries" ("shipmentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_shipment_line_deliveries_line" ON "shipment_line_deliveries" ("shipmentLineId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_shipment_line_deliveries_client_key" ON "shipment_line_deliveries" ("clientKey") WHERE "clientKey" IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "shipment_line_deliveries"`);
  }
}
