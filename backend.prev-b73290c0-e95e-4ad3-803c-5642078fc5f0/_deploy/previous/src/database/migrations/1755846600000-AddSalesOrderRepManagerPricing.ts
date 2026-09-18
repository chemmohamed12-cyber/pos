import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO instruction: per-rep order sequence number + three-tier line
 * pricing (list -> rep -> manager override). Existing orders/lines
 * backfill to safe defaults: `repSequenceNumber` = 1 for every existing
 * order (historical orders never had this concept; the real per-rep
 * numbering starts cleanly from the next NEW order each rep creates —
 * see `SalesOrdersService.createOrder`), `repPrice`/`managerPrice` stay
 * NULL (no override was ever entered for them).
 */
export class AddSalesOrderRepManagerPricing1755846600000 implements MigrationInterface {
  name = 'AddSalesOrderRepManagerPricing1755846600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_orders" ADD COLUMN "repSequenceNumber" INT NOT NULL DEFAULT 1`);
    await queryRunner.query(`ALTER TABLE "sales_order_lines" ADD COLUMN "repPrice" NUMERIC(12,2)`);
    await queryRunner.query(`ALTER TABLE "sales_order_lines" ADD COLUMN "managerPrice" NUMERIC(12,2)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_order_lines" DROP COLUMN "managerPrice"`);
    await queryRunner.query(`ALTER TABLE "sales_order_lines" DROP COLUMN "repPrice"`);
    await queryRunner.query(`ALTER TABLE "sales_orders" DROP COLUMN "repSequenceNumber"`);
  }
}
