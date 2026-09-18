import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §4) — every Shipping
 * Company / Company Vehicle gets an auto-created Operational
 * Sub-location warehouse. Existing rows all backfill to `kind='main'`,
 * `parentWarehouseId=NULL` (the column default) — no behavior change for
 * anything already using the Warehouse Engine.
 */
export class AddWarehouseSubLocationFields1755849000000 implements MigrationInterface {
  name = 'AddWarehouseSubLocationFields1755849000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "warehouses" ADD COLUMN "parentWarehouseId" UUID`);
    await queryRunner.query(`CREATE INDEX "IDX_warehouses_parentWarehouseId" ON "warehouses" ("parentWarehouseId")`);
    await queryRunner.query(`ALTER TABLE "warehouses" ADD COLUMN "kind" VARCHAR(16) NOT NULL DEFAULT 'main'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "warehouses" DROP COLUMN "kind"`);
    await queryRunner.query(`DROP INDEX "IDX_warehouses_parentWarehouseId"`);
    await queryRunner.query(`ALTER TABLE "warehouses" DROP COLUMN "parentWarehouseId"`);
  }
}
