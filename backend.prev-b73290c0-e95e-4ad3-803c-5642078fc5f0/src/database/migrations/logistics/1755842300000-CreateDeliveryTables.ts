import { MigrationInterface, QueryRunner } from 'typeorm';

/** Delivery — Stage 2 build-order item 31. */
export class CreateDeliveryTables1755842300000 implements MigrationInterface {
  name = 'CreateDeliveryTables1755842300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "delivery_outcomes" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "shipmentId" VARCHAR(255) NOT NULL,
        "outcome" VARCHAR(16) NOT NULL,
        "failureReason" VARCHAR(255),
        "recordedByUserId" UUID NOT NULL REFERENCES "users"("id"),
        "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_delivery_outcomes_shipmentId" ON "delivery_outcomes" ("shipmentId")`);

    await queryRunner.query(`
      CREATE TABLE "collections" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "shipmentId" VARCHAR(255) NOT NULL,
        "amount" NUMERIC(14,2) NOT NULL,
        "method" VARCHAR(32) NOT NULL,
        "collectorUserId" UUID NOT NULL REFERENCES "users"("id"),
        "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_collections_shipmentId" ON "collections" ("shipmentId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "collections"`);
    await queryRunner.query(`DROP TABLE "delivery_outcomes"`);
  }
}
