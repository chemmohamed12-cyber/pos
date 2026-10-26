import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vehicle Driver Workspace - separate expense float (CTO policy 2026-10-26): `vehicles.expenseFloatAccountId` is the Treasury account a vehicle's driver expenses are paid from. It is
 * a different account from the collection custody account (the service enforces that). Additive and nullable; no data rewrite. `down` drops the column.
 */
export class AddVehicleExpenseFloatAccount1790040400000 implements MigrationInterface {
  name = 'AddVehicleExpenseFloatAccount1790040400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "expenseFloatAccountId" UUID`);
    // One float belongs to one vehicle, and a float is never the vehicle's own collection custody or settlement account (the service checks first; the database is the backstop).
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_vehicles_expense_float" ON "vehicles" ("expenseFloatAccountId") WHERE "expenseFloatAccountId" IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE "vehicles" DROP CONSTRAINT IF EXISTS "CHK_vehicles_float_not_collection"`);
    await queryRunner.query(`ALTER TABLE "vehicles" ADD CONSTRAINT "CHK_vehicles_float_not_collection" CHECK ("expenseFloatAccountId" IS NULL OR ("expenseFloatAccountId" IS DISTINCT FROM "custodyAccountId" AND "expenseFloatAccountId" IS DISTINCT FROM "settlementAccountId"))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vehicles" DROP CONSTRAINT IF EXISTS "CHK_vehicles_float_not_collection"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_vehicles_expense_float"`);
    await queryRunner.query(`ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "expenseFloatAccountId"`);
  }
}
