import { MigrationInterface, QueryRunner } from 'typeorm';

/** CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §2) — a shipment may be carried by a specific Company Vehicle. */
export class AddShipmentVehicleId1755849300000 implements MigrationInterface {
  name = 'AddShipmentVehicleId1755849300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shipments" ADD COLUMN "vehicleId" UUID`);
    await queryRunner.query(`CREATE INDEX "IDX_shipments_vehicleId" ON "shipments" ("vehicleId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_shipments_vehicleId"`);
    await queryRunner.query(`ALTER TABLE "shipments" DROP COLUMN "vehicleId"`);
  }
}
