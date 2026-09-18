import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gap G-1 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md, CTO
 * handover directive §6) — per-customer Sales Order workflow switch.
 * DEFAULT 'standard' backfills every existing customer row so no current
 * behavior changes until an admin/sales_manager explicitly opts a
 * customer into 'open_account'.
 */
export class AddCustomerOrderWorkflowPolicy1755845000000 implements MigrationInterface {
  name = 'AddCustomerOrderWorkflowPolicy1755845000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "customers" ADD COLUMN "orderWorkflowPolicy" VARCHAR(16) NOT NULL DEFAULT 'standard'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "orderWorkflowPolicy"`);
  }
}
