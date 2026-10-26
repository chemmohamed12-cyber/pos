import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise Organizational Structure Engine — Stage 5 (CTO D-7). `branchOrgUnitId` is the organizational reference stamped on the document by the SERVER when it is
 * created (derived from the owning warehouse or the parent document — never a client field). Additive and nullable: no backfill (historical documents keep NULL until
 * the reviewed legacy reconciliation), no financial value touched.
 */
export class AddShipmentBranch1790021500000 implements MigrationInterface {
  name = 'AddShipmentBranch1790021500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "branchOrgUnitId" uuid NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_shipments_branchOrgUnitId" ON "shipments" ("branchOrgUnitId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shipments_branchOrgUnitId"`);
    await queryRunner.query(`ALTER TABLE "shipments" DROP COLUMN IF EXISTS "branchOrgUnitId"`);
  }
}
