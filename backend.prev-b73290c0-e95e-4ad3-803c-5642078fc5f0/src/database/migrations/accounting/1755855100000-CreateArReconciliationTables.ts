import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F04 — Accounts Receivable (ADR-036). One new table owned exclusively by
 * `accounting` — the AR↔GL reconciliation run log. Purely additive;
 * touches nothing outside `accounting`, alters no F01/F02/F03 table.
 */
export class CreateArReconciliationTables1755855100000 implements MigrationInterface {
  name = 'CreateArReconciliationTables1755855100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_ar_reconciliation_runs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "fiscalPeriodId" UUID,
        "asOfDate" DATE NOT NULL,
        "orgUnitId" UUID,
        "subledgerTotalBase" NUMERIC(20,4) NOT NULL,
        "glBalanceBase" NUMERIC(20,4) NOT NULL,
        "driftBase" NUMERIC(20,4) NOT NULL,
        "status" VARCHAR(16) NOT NULL,
        "driftBreakdown" JSONB,
        "runByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "closedAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_accounting_ar_reconciliation_runs_status"
          CHECK ("status" IN ('open','matched','drift_found','closed'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_ar_reconciliation_runs_org" ON "accounting_ar_reconciliation_runs" ("orgUnitId")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_ar_reconciliation_runs_asof" ON "accounting_ar_reconciliation_runs" ("asOfDate")`);
    // one OPEN run per (fiscalPeriodId, orgUnitId) scope (Blueprint §10)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_ar_reconciliation_runs_one_open"
       ON "accounting_ar_reconciliation_runs" (COALESCE("fiscalPeriodId", '00000000-0000-0000-0000-000000000000'), COALESCE("orgUnitId", '00000000-0000-0000-0000-000000000000'))
       WHERE "status" = 'open'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_ar_reconciliation_runs"`);
  }
}
