import { MigrationInterface, QueryRunner } from 'typeorm';

/** CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §2) — Company Vehicles as a first-class Operational Custodian. */
export class CreateVehicleTable1755849100000 implements MigrationInterface {
  name = 'CreateVehicleTable1755849100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "vehicles" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "plateNumber" VARCHAR(32) NOT NULL,
        "driverUserId" UUID,
        "shippingCompanyId" UUID,
        "branch" VARCHAR(128),
        "warehouseId" UUID,
        "custodyAccountId" UUID,
        "settlementAccountId" UUID,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_vehicles_code" ON "vehicles" ("code")`);
    await queryRunner.query(`CREATE INDEX "IDX_vehicles_shippingCompanyId" ON "vehicles" ("shippingCompanyId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "vehicles"`);
  }
}
