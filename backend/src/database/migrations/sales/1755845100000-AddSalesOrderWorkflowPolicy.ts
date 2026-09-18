import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gap G-1 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md, CTO
 * handover directive §6) — snapshots the customer's workflow policy onto
 * the order at creation time (same discipline as line `unitPrice`), so a
 * later change to the customer's policy never retroactively alters an
 * already-in-flight order's approval chain. DEFAULT 'standard' backfills
 * every existing order to the chain it actually ran under.
 */
export class AddSalesOrderWorkflowPolicy1755845100000 implements MigrationInterface {
  name = 'AddSalesOrderWorkflowPolicy1755845100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sales_orders" ADD COLUMN "workflowPolicy" VARCHAR(16) NOT NULL DEFAULT 'standard'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_orders" DROP COLUMN "workflowPolicy"`);
  }
}
