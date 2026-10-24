import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Manufacturing Engine S1 (2026-10-24, decisions D-ME-1/D-ME-4) — production RESULTS by outcome class. Additive only: one new table and one defaulted column; no existing
 * column changes meaning. `work_order_results` is the quantity/value ledger of what actually came out of a Work Order: scrap (consumed components written to the
 * configured loss account), recovered material, and the non-financial tracking classes (rework / rejected / held) that must be resolved before the order closes.
 * `operationId` is nullable on purpose: S4 attaches results to operation runs without a schema change here.
 */
export class CreateWorkOrderResults1790033000000 implements MigrationInterface {
  name = 'CreateWorkOrderResults1790033000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "quantityScrapped" INT NOT NULL DEFAULT 0`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "work_order_results" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workOrderId" UUID NOT NULL,
        "operationId" UUID,
        "outcomeClass" VARCHAR(16) NOT NULL,
        "productId" UUID NOT NULL,
        "quantity" INT NOT NULL,
        "valueBase" NUMERIC(20,4) NOT NULL DEFAULT 0,
        "requestId" VARCHAR(128) NOT NULL,
        "reason" VARCHAR(255),
        "sourceResultId" UUID,
        "resolvedAt" TIMESTAMPTZ,
        "resolution" VARCHAR(16),
        "resolvedByUserId" UUID,
        "createdByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_work_order_results_class" CHECK ("outcomeClass" IN ('good','scrap','recovered','rework','rejected','held','co_product','by_product')),
        CONSTRAINT "CHK_work_order_results_quantity_positive" CHECK ("quantity" > 0),
        CONSTRAINT "CHK_work_order_results_value_nonnegative" CHECK ("valueBase" >= 0),
        CONSTRAINT "CHK_work_order_results_resolution" CHECK ("resolution" IS NULL OR "resolution" IN ('good','scrap','rework'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_work_order_results_request" ON "work_order_results" ("workOrderId", "outcomeClass", "requestId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_order_results_work_order" ON "work_order_results" ("workOrderId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_order_results_source" ON "work_order_results" ("sourceResultId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "work_order_results"`);
    await queryRunner.query(`ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "quantityScrapped"`);
  }
}
