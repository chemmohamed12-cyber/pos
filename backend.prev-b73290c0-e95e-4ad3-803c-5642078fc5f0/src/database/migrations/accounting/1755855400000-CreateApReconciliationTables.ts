import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F05 — Accounts Payable (ADR-037). The mirror of
 * `CreateArReconciliationTables`, with two differences forced by "there
 * is no operational AP subledger yet" (ADR-037 D1/D2):
 *   - `subledgerTotalBase` / `driftBase` are NULLABLE (NULL = no
 *     supplier-ledger source);
 *   - `status` CHECK adds `'no_subledger_source'`.
 * Purely additive; touches nothing outside `accounting`, alters no
 * F01/F02/F03/F04 table.
 */
export class CreateApReconciliationTables1755855400000 implements MigrationInterface {
  name = 'CreateApReconciliationTables1755855400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_ap_reconciliation_runs" (
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
        CONSTRAINT "CHK_accounting_ap_reconciliation_runs_status"
          CHECK ("status" IN ('open','matched','drift_found','closed','no_subledger_source'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_ap_reconciliation_runs_org" ON "accounting_ap_reconciliation_runs" ("orgUnitId")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_ap_reconciliation_runs_asof" ON "accounting_ap_reconciliation_runs" ("asOfDate")`);
    // one OPEN run per (fiscalPeriodId, orgUnitId) scope (Blueprint §8)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_ap_reconciliation_runs_one_open"
       ON "accounting_ap_reconciliation_runs" (COALESCE("fiscalPeriodId", '00000000-0000-0000-0000-000000000000'), COALESCE("orgUnitId", '00000000-0000-0000-0000-000000000000'))
       WHERE "status" = 'open'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_ap_reconciliation_runs"`);
  }
}
