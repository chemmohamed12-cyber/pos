import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F10-H5 (ADR-043 D8). One new table, owned exclusively by `accounting` —
 * zero FK to/from `accounting_journal_entries`/`_lines` or any other
 * table (reporting-only, per D8 — never a posting-control gate). Purely
 * additive; touches nothing else.
 */
export class CreateTaxPeriodTable1755859300000 implements MigrationInterface {
  name = 'CreateTaxPeriodTable1755859300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_tax_periods" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "startDate" DATE NOT NULL,
        "endDate" DATE NOT NULL,
        "jurisdictionCode" VARCHAR(8),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_accounting_tax_periods_dates" CHECK ("endDate" >= "startDate")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_accounting_tax_periods_code" ON "accounting_tax_periods" ("code")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_tax_periods"`);
  }
}
