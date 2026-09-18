import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gap G-3 — snapshots the product's base price (`listPrice`) and which
 * Price List (if any) supplied the actually-charged `unitPrice` onto
 * each order line. Every EXISTING line predates this feature and simply
 * paid its own `unitPrice` with no override in play, so `listPrice`
 * backfills to `unitPrice` (zero variance) and `priceListId` stays null
 * — an accurate historical record, not a guess.
 */
export class AddSalesOrderLinePricing1755845700000 implements MigrationInterface {
  name = 'AddSalesOrderLinePricing1755845700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_order_lines" ADD COLUMN "listPrice" NUMERIC(12,2)`);
    await queryRunner.query(`UPDATE "sales_order_lines" SET "listPrice" = "unitPrice"`);
    await queryRunner.query(`ALTER TABLE "sales_order_lines" ALTER COLUMN "listPrice" SET NOT NULL`);

    await queryRunner.query(
      `ALTER TABLE "sales_order_lines" ADD COLUMN "priceListId" UUID REFERENCES "price_lists"("id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_order_lines" DROP COLUMN "priceListId"`);
    await queryRunner.query(`ALTER TABLE "sales_order_lines" DROP COLUMN "listPrice"`);
  }
}
