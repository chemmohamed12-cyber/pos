import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise Organizational Structure Engine — Stage 2 (CTO D-8). `vehicles.orgUnitId` is the validated owning branch that replaces the free-text `branch`.
 * Additive: nullable, no backfill (a legacy vehicle stays unassigned until an owner confirms its branch from the mapping report — nothing is guessed), and the
 * old `branch` text column is untouched.
 */
export class AddVehicleOrgUnit1790021100000 implements MigrationInterface {
  name = 'AddVehicleOrgUnit1790021100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "orgUnitId" uuid NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_vehicles_orgUnitId" ON "vehicles" ("orgUnitId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_vehicles_orgUnitId"`);
    await queryRunner.query(`ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "orgUnitId"`);
  }
}
