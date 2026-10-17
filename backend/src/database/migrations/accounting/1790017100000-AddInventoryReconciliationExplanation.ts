import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Inventory lifecycle, slice C1 (ADR-INV-09, CTO decision 2026-10-17) - reconciliation v2 records HOW MUCH of a difference is explained and by what basis.
 * Additive and nullable: runs written before this release keep NULL and are read exactly as before; the existing `status` values and their CHECK constraint
 * are NOT touched (`matched` / `drift_found` keep their meaning), the explanation lives in these columns and in `driftBreakdown`.
 *  - `explainedBase` / `unexplainedBase` - the part of the difference covered by itemised categories, and the remainder;
 *  - `basis` - how the valuation side was read: `current` (the running state) or `as_of` (rebuilt from the dated history);
 *  - `classification` - `matched` (difference exactly 0) | `explained` (non-zero, fully explained) | `unexplained` (something remains).
 * Idempotent; `down` removes exactly what `up` added. PostgreSQL 10 compatible.
 */
export class AddInventoryReconciliationExplanation1790017100000 implements MigrationInterface {
  name = 'AddInventoryReconciliationExplanation1790017100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounting_inventory_reconciliation_runs" ADD COLUMN IF NOT EXISTS "explainedBase" NUMERIC(20,4) NULL`);
    await queryRunner.query(`ALTER TABLE "accounting_inventory_reconciliation_runs" ADD COLUMN IF NOT EXISTS "unexplainedBase" NUMERIC(20,4) NULL`);
    await queryRunner.query(`ALTER TABLE "accounting_inventory_reconciliation_runs" ADD COLUMN IF NOT EXISTS "basis" VARCHAR(16) NULL`);
    await queryRunner.query(`ALTER TABLE "accounting_inventory_reconciliation_runs" ADD COLUMN IF NOT EXISTS "classification" VARCHAR(16) NULL`);
    await queryRunner.query(`ALTER TABLE "accounting_inventory_reconciliation_runs" DROP CONSTRAINT IF EXISTS "CHK_accounting_inventory_reconciliation_runs_classification"`);
    await queryRunner.query(
      `ALTER TABLE "accounting_inventory_reconciliation_runs" ADD CONSTRAINT "CHK_accounting_inventory_reconciliation_runs_classification"
         CHECK ("classification" IS NULL OR "classification" IN ('matched','explained','unexplained'))`,
    );
    await queryRunner.query(`ALTER TABLE "accounting_inventory_reconciliation_runs" DROP CONSTRAINT IF EXISTS "CHK_accounting_inventory_reconciliation_runs_basis"`);
    await queryRunner.query(
      `ALTER TABLE "accounting_inventory_reconciliation_runs" ADD CONSTRAINT "CHK_accounting_inventory_reconciliation_runs_basis"
         CHECK ("basis" IS NULL OR "basis" IN ('current','as_of'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounting_inventory_reconciliation_runs" DROP CONSTRAINT IF EXISTS "CHK_accounting_inventory_reconciliation_runs_basis"`);
    await queryRunner.query(`ALTER TABLE "accounting_inventory_reconciliation_runs" DROP CONSTRAINT IF EXISTS "CHK_accounting_inventory_reconciliation_runs_classification"`);
    await queryRunner.query(`ALTER TABLE "accounting_inventory_reconciliation_runs" DROP COLUMN IF EXISTS "classification"`);
    await queryRunner.query(`ALTER TABLE "accounting_inventory_reconciliation_runs" DROP COLUMN IF EXISTS "basis"`);
    await queryRunner.query(`ALTER TABLE "accounting_inventory_reconciliation_runs" DROP COLUMN IF EXISTS "unexplainedBase"`);
    await queryRunner.query(`ALTER TABLE "accounting_inventory_reconciliation_runs" DROP COLUMN IF EXISTS "explainedBase"`);
  }
}
