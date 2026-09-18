import { MigrationInterface, QueryRunner } from 'typeorm';

/** Fulfillment — Stage 2 build-order item 28. */
export class CreateFulfillmentTables1755842100000 implements MigrationInterface {
  name = 'CreateFulfillmentTables1755842100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "fulfillment_orders" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "salesOrderId" VARCHAR(255) NOT NULL,
        "warehouseId" UUID NOT NULL REFERENCES "warehouses"("id"),
        "reservationId" VARCHAR(255) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fulfillment_orders_salesOrderId" ON "fulfillment_orders" ("salesOrderId")`);

    await queryRunner.query(`
      CREATE TABLE "pick_tasks" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "fulfillmentOrderId" UUID NOT NULL REFERENCES "fulfillment_orders"("id") ON DELETE CASCADE,
        "assignedToUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_pick_tasks_fulfillmentOrderId" ON "pick_tasks" ("fulfillmentOrderId")`);

    await queryRunner.query(`
      CREATE TABLE "pack_tasks" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "fulfillmentOrderId" UUID NOT NULL REFERENCES "fulfillment_orders"("id") ON DELETE CASCADE,
        "assignedToUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_pack_tasks_fulfillmentOrderId" ON "pack_tasks" ("fulfillmentOrderId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "pack_tasks"`);
    await queryRunner.query(`DROP TABLE "pick_tasks"`);
    await queryRunner.query(`DROP TABLE "fulfillment_orders"`);
  }
}
