import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vehicle Driver Workspace - separate expense float (CTO policy 2026-10-26): `vehicles.expenseFloatAccountId` is the Treasury account a vehicle's driver expenses are paid from. It is
 * a different account from the collection custody account (the service enforces that). Additive and nullable; no data rewrite. `down` drops the column.
 */
export class AddVehicleExpenseFloatAccount1790040400000 implements MigrationInterface {
  name = 'AddVehicleExpenseFloatAccount1790040400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "expenseFloatAccountId" UUID`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "expenseFloatAccountId"`);
  }
}
