import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO directive ("FINAL SALES ORDER / CUSTOMER REVIEW") — two real gaps
 * found live:
 * (1) Stock was never checked/reserved until a LATE "Reserve Stock" step
 *     (after supervisor+manager approval) — `sales_orders.warehouseId`
 *     lets order creation reserve stock atomically up front instead.
 * (2) A Price List's resolved override price was never persisted or
 *     shown on its own — only the raw base price and a price-list code
 *     were visible, so a manager had no way to see WHERE a line's price
 *     actually came from (found live: a "150 -> 8" line that was, in
 *     fact, a correctly-applied Price List override nobody could see).
 *     `sales_order_lines.priceListPrice` is backfilled from the existing
 *     `listPrice` for historical rows (their true resolved price, had a
 *     Price List override applied, is not reconstructable after the
 *     fact — those rows predate this column existing at all).
 */
export class AddSalesOrderWarehouseAndPriceListPrice1755847300000 implements MigrationInterface {
  name = 'AddSalesOrderWarehouseAndPriceListPrice1755847300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_orders" ADD COLUMN "warehouseId" UUID`);
    await queryRunner.query(`CREATE INDEX "IDX_sales_orders_warehouseId" ON "sales_orders" ("warehouseId")`);

    await queryRunner.query(`ALTER TABLE "sales_order_lines" ADD COLUMN "priceListPrice" NUMERIC(12,2)`);
    await queryRunner.query(`UPDATE "sales_order_lines" SET "priceListPrice" = "listPrice" WHERE "priceListPrice" IS NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_order_lines" DROP COLUMN "priceListPrice"`);
    await queryRunner.query(`DROP INDEX "IDX_sales_orders_warehouseId"`);
    await queryRunner.query(`ALTER TABLE "sales_orders" DROP COLUMN "warehouseId"`);
  }
}
