import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Manufacturing Engine S4 (2026-10-24, decision D-ME-3) — EXECUTION of a process version on a Work Order. Additive: one nullable column and two new tables.
 *   - work_orders."processVersionId" : set only on process-bound orders; null = the unchanged Basic Profile (flat BOM + routing snapshot);
 *   - mfg_operation_runs             : one row per run of a process operation on an order (repeatable operations have runNo 1..maxRuns);
 *   - mfg_operation_flows            : the derived PRODUCTION LEDGER — material consumed (`in`) and quantities yielded (`out`) per run, with the material value they carried.
 * Physical WIP stays ONE sub-warehouse per order; per-operation quantity and value are read from these rows (decision D-ME-3), never stored as extra warehouses.
 */
export class CreateOperationRuns1790033400000 implements MigrationInterface {
  name = 'CreateOperationRuns1790033400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "processVersionId" UUID`);
    await queryRunner.query(`ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "processChoices" JSONB`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mfg_operation_runs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workOrderId" UUID NOT NULL,
        "operationId" UUID NOT NULL,
        "operationCode" VARCHAR(32) NOT NULL,
        "runNo" INT NOT NULL,
        "status" VARCHAR(12) NOT NULL DEFAULT 'running',
        "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "startedByUserId" UUID,
        "completedAt" TIMESTAMPTZ,
        "completedByUserId" UUID,
        "requestId" VARCHAR(128) NOT NULL,
        CONSTRAINT "CHK_mfg_operation_runs_status" CHECK ("status" IN ('running','completed','skipped'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mfg_operation_runs_order_op_run" ON "mfg_operation_runs" ("workOrderId","operationId","runNo")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mfg_operation_runs_request" ON "mfg_operation_runs" ("workOrderId","operationId","requestId")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mfg_operation_flows" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "runId" UUID NOT NULL,
        "workOrderId" UUID NOT NULL,
        "operationId" UUID NOT NULL,
        "direction" VARCHAR(3) NOT NULL,
        "productId" UUID NOT NULL,
        "quantity" INT NOT NULL,
        "valueBase" NUMERIC(20,4) NOT NULL DEFAULT 0,
        "requestId" VARCHAR(128) NOT NULL,
        "createdByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_mfg_operation_flows_direction" CHECK ("direction" IN ('in','out')),
        CONSTRAINT "CHK_mfg_operation_flows_quantity" CHECK ("quantity" > 0),
        CONSTRAINT "CHK_mfg_operation_flows_value" CHECK ("valueBase" >= 0)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mfg_operation_flows_request" ON "mfg_operation_flows" ("runId","direction","productId","requestId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mfg_operation_flows_order" ON "mfg_operation_flows" ("workOrderId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "mfg_operation_flows"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mfg_operation_runs"`);
    await queryRunner.query(`ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "processChoices"`);
    await queryRunner.query(`ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "processVersionId"`);
  }
}
