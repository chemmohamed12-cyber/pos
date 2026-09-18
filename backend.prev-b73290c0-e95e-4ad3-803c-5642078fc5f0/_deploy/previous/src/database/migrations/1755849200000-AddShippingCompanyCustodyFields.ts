import { MigrationInterface, QueryRunner } from 'typeorm';

/** CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §1/§4/§6) — address/responsible-person + the auto-created sub-location/custody-account links. */
export class AddShippingCompanyCustodyFields1755849200000 implements MigrationInterface {
  name = 'AddShippingCompanyCustodyFields1755849200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shipping_companies" ADD COLUMN "address" VARCHAR(500)`);
    await queryRunner.query(`ALTER TABLE "shipping_companies" ADD COLUMN "responsiblePerson" VARCHAR(255)`);
    await queryRunner.query(`ALTER TABLE "shipping_companies" ADD COLUMN "warehouseId" UUID`);
    await queryRunner.query(`ALTER TABLE "shipping_companies" ADD COLUMN "custodyAccountId" UUID`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shipping_companies" DROP COLUMN "custodyAccountId"`);
    await queryRunner.query(`ALTER TABLE "shipping_companies" DROP COLUMN "warehouseId"`);
    await queryRunner.query(`ALTER TABLE "shipping_companies" DROP COLUMN "responsiblePerson"`);
    await queryRunner.query(`ALTER TABLE "shipping_companies" DROP COLUMN "address"`);
  }
}
