import { MigrationInterface, QueryRunner } from 'typeorm';

/** CTO directive ("PRIORITY: ITEM PREPARATION") — per-product Pick Task lines, the granularity Fulfillment never had before. */
export class CreatePickTaskLineTable1755849700000 implements MigrationInterface {
  name = 'CreatePickTaskLineTable1755849700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "pick_task_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "pickTaskId" UUID NOT NULL,
        "fulfillmentOrderId" UUID NOT NULL,
        "productId" UUID NOT NULL,
        "requestedQuantity" INTEGER NOT NULL,
        "preparedQuantity" INTEGER NOT NULL DEFAULT 0,
        "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
        "preparedByUserId" UUID,
        "preparedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_pick_task_lines_pickTaskId" ON "pick_task_lines" ("pickTaskId")`);
    await queryRunner.query(`CREATE INDEX "IDX_pick_task_lines_fulfillmentOrderId" ON "pick_task_lines" ("fulfillmentOrderId")`);
    await queryRunner.query(`CREATE INDEX "IDX_pick_task_lines_productId" ON "pick_task_lines" ("productId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "pick_task_lines"`);
  }
}
