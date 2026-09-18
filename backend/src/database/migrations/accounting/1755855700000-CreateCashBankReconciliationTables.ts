import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F06 — Cash & Bank (ADR-038 D9). The mirror of
 * `CreateApReconciliationTables`, with the F06 differences:
 *   - keyed by `treasuryAccountId` + `glAccountCode` (per-account run);
 *   - `subledgerTotalBase` / `driftBase` are NOT NULL — the Treasury
 *     operational ledger always exists, so no `no_subledger_source`.
 * Purely additive; `accounting`-tagged; touches nothing outside
 * `accounting`, alters no F01–F05 table.
 */
export class CreateCashBankReconciliationTables1755855700000 implements MigrationInterface {
  name = 'CreateCashBankReconciliationTables1755855700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_cash_bank_reconciliation_runs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "treasuryAccountId" UUID NOT NULL,
        "glAccountCode" VARCHAR(32) NOT NULL,
        "fiscalPeriodId" UUID,
        "asOfDate" DATE NOT NULL,
        "orgUnitId" UUID,
        "subledgerTotalBase" NUMERIC(20,4) NOT NULL,
        "glBalanceBase" NUMERIC(20,4) NOT NULL,
        "driftBase" NUMERIC(20,4) NOT NULL,
        "status" VARCHAR(24) NOT NULL,
        "driftBreakdown" JSONB,
        "runByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "closedAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_accounting_cash_bank_reconciliation_runs_status"
          CHECK ("status" IN ('open','matched','drift_found','closed'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_accounting_cash_bank_reconciliation_runs_account" ON "accounting_cash_bank_reconciliation_runs" ("treasuryAccountId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_accounting_cash_bank_reconciliation_runs_org" ON "accounting_cash_bank_reconciliation_runs" ("orgUnitId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_accounting_cash_bank_reconciliation_runs_asof" ON "accounting_cash_bank_reconciliation_runs" ("asOfDate")`,
    );
    // one OPEN run per (treasuryAccountId, fiscalPeriodId, orgUnitId) scope
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_cash_bank_reconciliation_runs_one_open"
       ON "accounting_cash_bank_reconciliation_runs" (
         "treasuryAccountId",
         COALESCE("fiscalPeriodId", '00000000-0000-0000-0000-000000000000'),
         COALESCE("orgUnitId", '00000000-0000-0000-0000-000000000000')
       )
       WHERE "status" = 'open'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_cash_bank_reconciliation_runs"`);
  }
}
