import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Org engine WP-C (decision D-C option A, approved 2026-10-26) — `work_orders.branchOrgUnitId`: the branch of the PRODUCTION warehouse, stamped when the work order is created.
 * WIP, material issue/return and finished-goods postings carry it. Additive and nullable; no backfill (earlier work orders keep NULL = company level, exactly as before).
 */
export class AddWorkOrderBranch1790031100000 implements MigrationInterface {
  name = 'AddWorkOrderBranch1790031100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "branchOrgUnitId" uuid NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_branchOrgUnitId" ON "work_orders" ("branchOrgUnitId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_work_orders_branchOrgUnitId"`);
    await queryRunner.query(`ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "branchOrgUnitId"`);
  }
}
