import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise Organizational Structure Engine — Stage 5 (CTO D-7). `branchOrgUnitId` is the organizational reference stamped on the document by the SERVER when it is
 * created (derived from the owning warehouse or the parent document — never a client field). Additive and nullable: no backfill (historical documents keep NULL until
 * the reviewed legacy reconciliation), no financial value touched.
 */
export class AddFulfillmentOrderBranch1790021400000 implements MigrationInterface {
  name = 'AddFulfillmentOrderBranch1790021400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "fulfillment_orders" ADD COLUMN IF NOT EXISTS "branchOrgUnitId" uuid NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_fulfillment_orders_branchOrgUnitId" ON "fulfillment_orders" ("branchOrgUnitId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fulfillment_orders_branchOrgUnitId"`);
    await queryRunner.query(`ALTER TABLE "fulfillment_orders" DROP COLUMN IF EXISTS "branchOrgUnitId"`);
  }
}
