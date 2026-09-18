import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-050 — Period Closing Audit Engine. One row per `ClosingAuditService.run()`
 * call: aggregates the five existing reconciliation services' verdicts plus
 * in-period REJECTED financial events for a single `FiscalPeriod`. Purely
 * additive; touches nothing outside `accounting`, alters no existing table.
 */
export class CreateClosingAuditRunTable1789701200000 implements MigrationInterface {
  name = 'CreateClosingAuditRunTable1789701200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_closing_audit_runs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "fiscalPeriodId" UUID NOT NULL,
        "asOfDate" DATE NOT NULL,
        "orgUnitId" UUID,
        "status" VARCHAR(24) NOT NULL,
        "exceptions" JSONB NOT NULL DEFAULT '[]'::jsonb,
        "runByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_accounting_closing_audit_runs_status" CHECK ("status" IN ('clean', 'exceptions_found'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_closing_audit_runs_period" ON "accounting_closing_audit_runs" ("fiscalPeriodId")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_closing_audit_runs_asof" ON "accounting_closing_audit_runs" ("asOfDate")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_closing_audit_runs"`);
  }
}
