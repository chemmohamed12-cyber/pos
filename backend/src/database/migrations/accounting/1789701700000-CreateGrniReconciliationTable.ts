import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-054/ADR-056 (Month-End Closing, Phase 8). The mirror of
 * `CreateApReconciliationTables` — identical shape, one new table.
 * Purely additive; touches nothing outside `accounting`, alters no
 * existing table (ADR-056's explicit "additive extension" requirement).
 */
export class CreateGrniReconciliationTable1789701700000 implements MigrationInterface {
  name = 'CreateGrniReconciliationTable1789701700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_grni_reconciliation_runs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "fiscalPeriodId" UUID,
        "asOfDate" DATE NOT NULL,
        "orgUnitId" UUID,
        "subledgerTotalBase" NUMERIC(20,4),
        "glBalanceBase" NUMERIC(20,4) NOT NULL,
        "driftBase" NUMERIC(20,4),
        "status" VARCHAR(24) NOT NULL,
        "driftBreakdown" JSONB,
        "runByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "closedAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_accounting_grni_reconciliation_runs_status"
          CHECK ("status" IN ('open','matched','drift_found','closed','no_subledger_source'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_grni_reconciliation_runs_org" ON "accounting_grni_reconciliation_runs" ("orgUnitId")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_grni_reconciliation_runs_asof" ON "accounting_grni_reconciliation_runs" ("asOfDate")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_grni_reconciliation_runs_one_open"
       ON "accounting_grni_reconciliation_runs" (COALESCE("fiscalPeriodId", '00000000-0000-0000-0000-000000000000'), COALESCE("orgUnitId", '00000000-0000-0000-0000-000000000000'))
       WHERE "status" = 'open'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_grni_reconciliation_runs"`);
  }
}
