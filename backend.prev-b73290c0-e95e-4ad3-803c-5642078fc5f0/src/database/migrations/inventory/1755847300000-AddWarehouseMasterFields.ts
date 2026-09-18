import { MigrationInterface, QueryRunner } from 'typeorm';

/** Warehouse ERP V1 / Phase 1 Integration (CTO directive §3) — Warehouse Master: location, responsible user, active/inactive status. */
export class AddWarehouseMasterFields1755847300000 implements MigrationInterface {
  name = 'AddWarehouseMasterFields1755847300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "warehouses"
        ADD COLUMN "location" VARCHAR(500),
        ADD COLUMN "responsibleUserId" UUID,
        ADD COLUMN "status" VARCHAR(16) NOT NULL DEFAULT 'active'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "warehouses"
        DROP COLUMN "location",
        DROP COLUMN "responsibleUserId",
        DROP COLUMN "status"
    `);
  }
}
