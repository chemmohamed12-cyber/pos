import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO instruction (Sales Order detail screen must show customer name/
 * phone, the responsible rep, and who actually created the order) —
 * `createdByUserId` is genuinely distinct from `salesRepUserId` now that
 * a manager may create an order under a different rep's name. Existing
 * orders backfill to NULL (their true creator is only recoverable from
 * the audit log's `sales.order.created` entry, not reconstructed here).
 */
export class AddSalesOrderCreatedBy1755846800000 implements MigrationInterface {
  name = 'AddSalesOrderCreatedBy1755846800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_orders" ADD COLUMN "createdByUserId" UUID`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_orders" DROP COLUMN "createdByUserId"`);
  }
}
