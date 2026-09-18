import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-051 (Month-End Closing / Black Box, Phase 5). One row per Immutable
 * Monthly Accounting Snapshot. Purely additive.
 */
export class CreateClosingSnapshotRunTable1789701600000 implements MigrationInterface {
  name = 'CreateClosingSnapshotRunTable1789701600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_closing_snapshot_runs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "fiscalPeriodId" UUID NOT NULL,
        "closeSequence" INT NOT NULL,
        "supersedesSnapshotId" UUID,
        "approvalRequestId" UUID NOT NULL,
        "status" VARCHAR(16) NOT NULL,
        "contentHash" VARCHAR(128),
        "signingKeyId" VARCHAR(64),
        "signature" TEXT,
        "manifestPath" TEXT,
        "generatedByUserId" UUID NOT NULL,
        "generatedAt" TIMESTAMPTZ,
        "appVersion" VARCHAR(64),
        "migrationHead" VARCHAR(64),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_accounting_closing_snapshot_runs_status" CHECK ("status" IN ('pending', 'complete', 'failed'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_closing_snapshot_runs_period" ON "accounting_closing_snapshot_runs" ("fiscalPeriodId")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_closing_snapshot_runs_approval" ON "accounting_closing_snapshot_runs" ("approvalRequestId")`);
    // one snapshot run per FA-01 approval — the transactional-outbox-style "begin pending" step
    // (ADR-051 §12) must be idempotent under a duplicate approval-event delivery, exactly like
    // FiscalPeriodService's own applyApprovedPeriodTransition already is for the transition itself.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_closing_snapshot_runs_one_per_approval" ON "accounting_closing_snapshot_runs" ("approvalRequestId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_closing_snapshot_runs"`);
  }
}
