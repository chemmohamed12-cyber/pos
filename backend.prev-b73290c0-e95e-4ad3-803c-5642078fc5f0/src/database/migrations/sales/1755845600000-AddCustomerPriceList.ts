import { MigrationInterface, QueryRunner } from 'typeorm';

/** Gap G-3 — per-customer Price List assignment. Nullable + no default backfills every existing customer to "no override" (unchanged pricing). */
export class AddCustomerPriceList1755845600000 implements MigrationInterface {
  name = 'AddCustomerPriceList1755845600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "customers" ADD COLUMN "priceListId" UUID REFERENCES "price_lists"("id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "priceListId"`);
  }
}
