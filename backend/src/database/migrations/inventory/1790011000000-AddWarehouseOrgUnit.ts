import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Authorization Foundation F6 (Blueprint §10, decision D12) — optional LINK from a warehouse to an organization unit (branch / warehouse unit). The link is the
 * scope key of the F6 pilot (stock, warehouse transactions, PR/PO/GR, sales orders all carry a warehouse). NULL = unscoped = visible to everyone: every existing
 * installation behaves exactly as before until someone links a warehouse. `inventory`-tagged because `warehouses` is owned by the inventory module.
 */
export class AddWarehouseOrgUnit1790011000000 implements MigrationInterface {
  name = 'AddWarehouseOrgUnit1790011000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "warehouses" ADD COLUMN IF NOT EXISTS "orgUnitId" UUID NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_warehouses_orgUnitId" ON "warehouses" ("orgUnitId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_warehouses_orgUnitId"`);
    await queryRunner.query(`ALTER TABLE "warehouses" DROP COLUMN IF EXISTS "orgUnitId"`);
  }
}
