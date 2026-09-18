import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gap G-4 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §4,
 * `قيمه الخصم`) — flat discount amount per Sales Order line. DEFAULT 0
 * backfills every existing line to "no discount", matching the total it
 * was actually created with.
 */
export class AddSalesOrderLineDiscount1755845300000 implements MigrationInterface {
  name = 'AddSalesOrderLineDiscount1755845300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sales_order_lines" ADD COLUMN "discountAmount" NUMERIC(12,2) NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_order_lines" DROP COLUMN "discountAmount"`);
  }
}
