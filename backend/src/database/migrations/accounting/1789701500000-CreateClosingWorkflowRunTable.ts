import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-051 (Month-End Closing / Black Box, Phase 3). One row per closing
 * attempt (first close or reclose) — the persisted evidence trail behind
 * the Closing Audit → Exception Gate → Final Reconciliation → FA-01 →
 * Period Lock invariant. Purely additive.
 */
export class CreateClosingWorkflowRunTable1789701500000 implements MigrationInterface {
  name = 'CreateClosingWorkflowRunTable1789701500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_closing_workflow_runs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "fiscalPeriodId" UUID NOT NULL,
        "entryState" VARCHAR(16) NOT NULL,
        "finalReconciliationRunId" UUID,
        "approvalRequestId" UUID,
        "status" VARCHAR(32) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "completedAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_accounting_closing_workflow_runs_entry_state" CHECK ("entryState" IN ('soft_close', 'reopened')),
        CONSTRAINT "CHK_accounting_closing_workflow_runs_status" CHECK ("status" IN (
          'audit_run', 'exceptions_open', 'final_reconciliation_passed', 'approval_submitted', 'approved', 'period_locked', 'failed'
        ))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_closing_workflow_runs_period" ON "accounting_closing_workflow_runs" ("fiscalPeriodId")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_closing_workflow_runs_approval" ON "accounting_closing_workflow_runs" ("approvalRequestId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_closing_workflow_runs"`);
  }
}
