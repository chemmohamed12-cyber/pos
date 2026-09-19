import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-061 (Manufacturing) Month-End dependency, resolved per the independent
 * post-implementation review's Phase 1 finding. The mirror of
 * `CreateGrniReconciliationTable` — identical shape, one new table.
 * Purely additive; touches nothing outside `accounting`, alters no
 * existing table.
 */
export class CreateWipReconciliationTable1789733000000 implements MigrationInterface {
  name = 'CreateWipReconciliationTable1789733000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_wip_reconciliation_runs" (
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
        CONSTRAINT "CHK_accounting_wip_reconciliation_runs_status"
          CHECK ("status" IN ('open','matched','drift_found','closed','no_subledger_source'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_wip_reconciliation_runs_org" ON "accounting_wip_reconciliation_runs" ("orgUnitId")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_wip_reconciliation_runs_asof" ON "accounting_wip_reconciliation_runs" ("asOfDate")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_wip_reconciliation_runs_one_open"
       ON "accounting_wip_reconciliation_runs" (COALESCE("fiscalPeriodId", '00000000-0000-0000-0000-000000000000'), COALESCE("orgUnitId", '00000000-0000-0000-0000-000000000000'))
       WHERE "status" = 'open'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_wip_reconciliation_runs"`);
  }
}
