import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-061 Addendum 1 (A1, 2026-10-06) — Routing / Operations / Work Centers as NON-COSTING
 * sequencing master data. New tables only. Deliberately NO labor-hours, machine-hours, rate,
 * overhead or cost column anywhere (ADR-060 D2/D3 stand). `work_order_operations` is the
 * release-time snapshot of the routing (same snapshot-is-authoritative rule as
 * `work_order_components`, ADR-061 §2).
 */
export class CreateRoutingAndWorkCenterTables1790000100000 implements MigrationInterface {
  name = 'CreateRoutingAndWorkCenterTables1790000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "work_centers" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "description" VARCHAR(500),
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_work_centers_status" CHECK ("status" IN ('active', 'inactive'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_work_centers_code" ON "work_centers" ("code")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "routings" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "finishedProductId" UUID NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_routings_status" CHECK ("status" IN ('active', 'inactive'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_routings_finished_product" ON "routings" ("finishedProductId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "routing_operations" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "routingId" UUID NOT NULL REFERENCES "routings"("id") ON DELETE CASCADE,
        "sequence" INT NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "description" VARCHAR(500),
        "workCenterId" UUID NOT NULL,
        CONSTRAINT "CHK_routing_operations_sequence_positive" CHECK ("sequence" > 0)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_routing_operations_routing_sequence" ON "routing_operations" ("routingId", "sequence")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_routing_operations_work_center" ON "routing_operations" ("workCenterId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "work_order_operations" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workOrderId" UUID NOT NULL,
        "sequence" INT NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "description" VARCHAR(500),
        "workCenterId" UUID NOT NULL,
        "workCenterCode" VARCHAR(32) NOT NULL,
        "workCenterName" VARCHAR(255) NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
        "startedAt" TIMESTAMPTZ,
        "startedByUserId" UUID,
        "completedAt" TIMESTAMPTZ,
        "completedByUserId" UUID,
        CONSTRAINT "CHK_work_order_operations_status" CHECK ("status" IN ('pending', 'in_progress', 'completed')),
        CONSTRAINT "CHK_work_order_operations_sequence_positive" CHECK ("sequence" > 0)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_work_order_operations_wo_sequence" ON "work_order_operations" ("workOrderId", "sequence")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_order_operations_work_center" ON "work_order_operations" ("workCenterId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "work_order_operations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "routing_operations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "routings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "work_centers"`);
  }
}
