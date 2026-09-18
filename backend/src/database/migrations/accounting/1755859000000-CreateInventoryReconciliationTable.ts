import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F07 — Inventory Accounting (ADR-040 D10). The mirror of
 * `CreateApReconciliationTables`, with the same shape forced by "there is
 * no valuation source yet" (ADR-040 D3):
 *   - `subledgerTotalBase` / `driftBase` are NULLABLE (NULL = no
 *     valuation source);
 *   - `status` CHECK adds `'no_valuation_source'`.
 * Purely additive; touches nothing outside `accounting`, alters no
 * F01/F02/F03/F04/F05/F06 table, and no `inventory-warehouse`-tagged
 * table (F07-H1's publisher change needs no schema change at all — the
 * cost fields are event-payload-only literals, not persisted columns).
 */
export class CreateInventoryReconciliationTable1755859000000 implements MigrationInterface {
  name = 'CreateInventoryReconciliationTable1755859000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_inventory_reconciliation_runs" (
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
        CONSTRAINT "CHK_accounting_inventory_reconciliation_runs_status"
          CHECK ("status" IN ('open','matched','drift_found','closed','no_valuation_source'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_accounting_inventory_reconciliation_runs_org" ON "accounting_inventory_reconciliation_runs" ("orgUnitId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_accounting_inventory_reconciliation_runs_asof" ON "accounting_inventory_reconciliation_runs" ("asOfDate")`,
    );
    // one OPEN run per (fiscalPeriodId, orgUnitId) scope
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_inventory_reconciliation_runs_one_open"
       ON "accounting_inventory_reconciliation_runs" (COALESCE("fiscalPeriodId", '00000000-0000-0000-0000-000000000000'), COALESCE("orgUnitId", '00000000-0000-0000-0000-000000000000'))
       WHERE "status" = 'open'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_inventory_reconciliation_runs"`);
  }
}
