import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-051 (Month-End Closing / Black Box, Phase 2). One row per Closing
 * Audit finding — replaces ADR-050's `accounting_closing_audit_runs.
 * exceptions` JSONB array (Study §C.1) with a first-class, resolvable
 * record. Purely additive; the `accounting_closing_audit_runs` table and
 * its existing `exceptions` column are left in place (unused by new code
 * going forward, but not dropped — no destructive change to an
 * already-shipped table).
 */
export class CreateClosingExceptionTable1789701400000 implements MigrationInterface {
  name = 'CreateClosingExceptionTable1789701400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_closing_exceptions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "closingAuditRunId" UUID NOT NULL,
        "fiscalPeriodId" UUID NOT NULL,
        "module" VARCHAR(24) NOT NULL,
        "documentType" VARCHAR(64),
        "documentId" VARCHAR(64),
        "transactionRef" VARCHAR(64),
        "accountOrSubledgerRef" VARCHAR(64),
        "amount" NUMERIC(20,4),
        "source" VARCHAR(64) NOT NULL,
        "category" VARCHAR(32) NOT NULL,
        "severity" VARCHAR(16) NOT NULL,
        "problem" TEXT NOT NULL,
        "requiredAction" TEXT NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'open',
        "resolvedByUserId" UUID,
        "resolvedAt" TIMESTAMPTZ,
        "resolutionNote" TEXT,
        "annotation" JSONB,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_accounting_closing_exceptions_severity" CHECK ("severity" IN ('blocking', 'informational')),
        CONSTRAINT "CHK_accounting_closing_exceptions_status" CHECK ("status" IN ('open', 'acknowledged', 'resolved', 'waived')),
        CONSTRAINT "CHK_accounting_closing_exceptions_category" CHECK ("category" IN (
          'LIVE_DISCREPANCY', 'DORMANT_SOURCE', 'EXPECTED_BUSINESS_REJECTION',
          'CONFIGURATION_EXCEPTION', 'HISTORICAL_TEST_ARTIFACT', 'UNCLASSIFIED_REJECTION'
        ))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_closing_exceptions_run" ON "accounting_closing_exceptions" ("closingAuditRunId")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_closing_exceptions_period" ON "accounting_closing_exceptions" ("fiscalPeriodId")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_closing_exceptions_severity" ON "accounting_closing_exceptions" ("severity")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_closing_exceptions_status" ON "accounting_closing_exceptions" ("status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_closing_exceptions"`);
  }
}
