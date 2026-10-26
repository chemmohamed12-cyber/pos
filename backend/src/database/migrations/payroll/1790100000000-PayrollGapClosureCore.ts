import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payroll gap closure (CTO mandate 2026-10-25, ADR-070 Addendum 1 — working contract) — additive schema only.
 *
 *  - `payroll_runs`: `revision` / `kind` / `supersedesRunId` (A-4), rejection record (A-9), stored totals, input fingerprint,
 *    status value `superseded`. The one-run-per-period unique index (`UQ_payroll_runs_period`) is replaced by
 *    UNIQUE(period, revision) + "one non-superseded REGULAR run per period" + "one open SUPPLEMENTARY run per period".
 *  - `payroll_periods`: close record + a core-SQL trigger that refuses overlapping periods (no CREATE EXTENSION, same
 *    reasoning as `targets_check_non_overlap`).
 *  - `payroll_compensations.reason` (effective-dated change with a reason, ADR-067 §B).
 *  - `payroll_run_lines.adjustmentsAmount` (explicit adjustment inputs, A-3).
 *  - `payroll_run_stage_actors` (actor per stage, A-6), `payroll_exceptions` (A-9/A-10),
 *    `payroll_input_consumptions` (exactly-once consumption of commission results / adjustments, A-2/A-3),
 *    `payroll_payout_batches` / `payroll_payout_items` (A-7), `payroll_settings` (SoD profile).
 * Existing rows map to revision 1 / kind 'regular'; no existing row is rewritten.
 */
export class PayrollGapClosureCore1790100000000 implements MigrationInterface {
  name = 'PayrollGapClosureCore1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // D-4 (CTO 2026-10-26): the new CHK_payroll_periods_range invariant is never weakened. A period whose start is after its end cannot satisfy it, so refuse BEFORE any change,
    // naming the rows (the migration is transactional, nothing is altered); the rows must be corrected deliberately - the migration does not guess the intended dates.
    const inverted: Array<{ code: string; startDate: string; endDate: string }> = await queryRunner.query(`SELECT "code", "startDate"::text AS "startDate", "endDate"::text AS "endDate" FROM "payroll_periods" WHERE "startDate" > "endDate" ORDER BY "code"`);
    if (inverted.length > 0) {
      throw new Error(`PayrollGapClosureCore refused: ${inverted.length} payroll period(s) have startDate after endDate and must be corrected first: ${inverted.map((p) => `${p.code} (${p.startDate} > ${p.endDate})`).join(', ')}`);
    }
    // ---- runs ---------------------------------------------------------------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "payroll_runs"
        ADD COLUMN "revision" INT NOT NULL DEFAULT 1,
        ADD COLUMN "kind" VARCHAR(16) NOT NULL DEFAULT 'regular',
        ADD COLUMN "supersedesRunId" UUID,
        ADD COLUMN "rejectedAt" TIMESTAMPTZ,
        ADD COLUMN "rejectedByUserId" UUID,
        ADD COLUMN "rejectionReason" TEXT,
        ADD COLUMN "inputsFingerprint" VARCHAR(64),
        ADD COLUMN "totalGross" NUMERIC(14,2),
        ADD COLUMN "totalCommission" NUMERIC(14,2),
        ADD COLUMN "totalAdjustments" NUMERIC(14,2),
        ADD COLUMN "totalDeductions" NUMERIC(14,2),
        ADD COLUMN "totalNet" NUMERIC(14,2)
    `);
    await queryRunner.query(`ALTER TABLE "payroll_runs" DROP CONSTRAINT "CHK_payroll_runs_status"`);
    await queryRunner.query(
      `ALTER TABLE "payroll_runs" ADD CONSTRAINT "CHK_payroll_runs_status" CHECK ("status" IN ('draft', 'calculated', 'reviewed', 'approved', 'posted', 'superseded'))`,
    );
    await queryRunner.query(`ALTER TABLE "payroll_runs" ADD CONSTRAINT "CHK_payroll_runs_kind" CHECK ("kind" IN ('regular', 'supplementary'))`);
    await queryRunner.query(`DROP INDEX "UQ_payroll_runs_period"`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payroll_runs_period_revision" ON "payroll_runs" ("payrollPeriodId", "revision")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_payroll_runs_period_active_regular" ON "payroll_runs" ("payrollPeriodId") WHERE "kind" = 'regular' AND "status" <> 'superseded'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_payroll_runs_period_open_supplementary" ON "payroll_runs" ("payrollPeriodId") WHERE "kind" = 'supplementary' AND "status" NOT IN ('posted', 'superseded')`,
    );

    // ---- lines ------------------------------------------------------------------------------------------------------------------------
    await queryRunner.query(`ALTER TABLE "payroll_run_lines" ADD COLUMN "adjustmentsAmount" NUMERIC(14,2) NOT NULL DEFAULT 0`);

    // ---- periods ----------------------------------------------------------------------------------------------------------------------
    await queryRunner.query(`ALTER TABLE "payroll_periods" ADD COLUMN "closedAt" TIMESTAMPTZ, ADD COLUMN "closedByUserId" UUID`);
    await queryRunner.query(`ALTER TABLE "payroll_periods" ADD CONSTRAINT "CHK_payroll_periods_range" CHECK ("startDate" <= "endDate")`);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION payroll_periods_check_overlap() RETURNS TRIGGER AS $BODY$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('payroll:periods'));
        IF EXISTS (
          SELECT 1 FROM "payroll_periods"
          WHERE "id" <> NEW."id"
            AND daterange("startDate", "endDate", '[]') && daterange(NEW."startDate", NEW."endDate", '[]')
        ) THEN
          RAISE EXCEPTION 'payroll period % - % overlaps an existing payroll period', NEW."startDate", NEW."endDate"
            USING ERRCODE = '23P01';
        END IF;
        RETURN NEW;
      END;
      $BODY$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_payroll_periods_overlap"
        BEFORE INSERT OR UPDATE OF "startDate", "endDate" ON "payroll_periods"
        FOR EACH ROW EXECUTE FUNCTION payroll_periods_check_overlap()
    `);

    // ---- compensation reason ----------------------------------------------------------------------------------------------------------
    await queryRunner.query(`ALTER TABLE "payroll_compensations" ADD COLUMN "reason" TEXT`);

    // ---- stage actors -----------------------------------------------------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "payroll_run_stage_actors" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "payrollRunId" UUID NOT NULL,
        "stage" VARCHAR(24) NOT NULL,
        "userId" UUID NOT NULL,
        "note" TEXT,
        "at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_payroll_stage_actor_stage" CHECK ("stage" IN ('prepare', 'review', 'acknowledge_exception', 'submit', 'approve', 'disburse', 'reconcile', 'close_period'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_stage_actors_run" ON "payroll_run_stage_actors" ("payrollRunId", "stage")`);

    // ---- exceptions -------------------------------------------------------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "payroll_exceptions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "payrollRunId" UUID NOT NULL,
        "employeeId" UUID,
        "code" VARCHAR(48) NOT NULL,
        "impactClass" VARCHAR(16) NOT NULL,
        "detail" JSONB NOT NULL DEFAULT '{}'::jsonb,
        "fingerprint" VARCHAR(64) NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'open',
        "decisionRef" TEXT,
        "acknowledgedByUserId" UUID,
        "acknowledgedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_payroll_exceptions_class" CHECK ("impactClass" IN ('B_APPROVE', 'A_DOC', 'INFO')),
        CONSTRAINT "CHK_payroll_exceptions_status" CHECK ("status" IN ('open', 'acknowledged', 'resolved'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_exceptions_run" ON "payroll_exceptions" ("payrollRunId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payroll_exceptions_run_fingerprint" ON "payroll_exceptions" ("payrollRunId", "fingerprint")`);

    // ---- exactly-once consumption of commission results / adjustments -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "payroll_input_consumptions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "inputKind" VARCHAR(24) NOT NULL,
        "sourceId" UUID NOT NULL,
        "payrollRunId" UUID NOT NULL,
        "payrollRunLineId" UUID,
        "employeeId" UUID NOT NULL,
        "amount" NUMERIC(14,2) NOT NULL,
        "state" VARCHAR(12) NOT NULL DEFAULT 'reserved',
        "carriedForward" BOOLEAN NOT NULL DEFAULT false,
        "attributionDate" DATE,
        "detail" JSONB NOT NULL DEFAULT '{}'::jsonb,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "consumedAt" TIMESTAMPTZ,
        "releasedAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_payroll_input_consumptions_kind" CHECK ("inputKind" IN ('commission_result', 'commission_adjustment', 'payroll_adjustment')),
        CONSTRAINT "CHK_payroll_input_consumptions_state" CHECK ("state" IN ('reserved', 'consumed', 'released'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_input_consumptions_run" ON "payroll_input_consumptions" ("payrollRunId")`);
    // The invariant: a source is held by AT MOST ONE live (reserved / consumed) consumption — enforced by the database.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_payroll_input_consumptions_live_source" ON "payroll_input_consumptions" ("inputKind", "sourceId") WHERE "state" IN ('reserved', 'consumed')`,
    );

    // ---- payouts ----------------------------------------------------------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "payroll_payout_batches" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "payrollRunId" UUID NOT NULL,
        "treasuryAccountId" UUID NOT NULL,
        "method" VARCHAR(24),
        "status" VARCHAR(24) NOT NULL DEFAULT 'draft',
        "executions" INT NOT NULL DEFAULT 0,
        "createdByUserId" UUID NOT NULL,
        "executedByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "executedAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_payroll_payout_batches_status" CHECK ("status" IN ('draft', 'executing', 'completed', 'partially_completed', 'failed', 'cancelled'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payroll_payout_batches_code" ON "payroll_payout_batches" ("code")`);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_payout_batches_run" ON "payroll_payout_batches" ("payrollRunId")`);
    await queryRunner.query(`
      CREATE TABLE "payroll_payout_items" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "payoutBatchId" UUID NOT NULL,
        "payrollRunId" UUID NOT NULL,
        "payrollRunLineId" UUID NOT NULL,
        "employeeId" UUID NOT NULL,
        "amount" NUMERIC(14,2) NOT NULL,
        "seq" INT NOT NULL,
        "idempotencyKey" VARCHAR(128) NOT NULL,
        "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
        "treasuryTransactionId" UUID,
        "failureReason" TEXT,
        "supersedesItemId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "settledAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_payroll_payout_items_status" CHECK ("status" IN ('pending', 'paid', 'failed')),
        CONSTRAINT "CHK_payroll_payout_items_amount" CHECK ("amount" > 0)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payroll_payout_items_key" ON "payroll_payout_items" ("idempotencyKey")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payroll_payout_items_line_seq" ON "payroll_payout_items" ("payrollRunLineId", "seq")`);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_payout_items_batch" ON "payroll_payout_items" ("payoutBatchId")`);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_payout_items_run" ON "payroll_payout_items" ("payrollRunId")`);

    // ---- settings ---------------------------------------------------------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "payroll_settings" (
        "key" VARCHAR(48) PRIMARY KEY,
        "value" VARCHAR(255) NOT NULL,
        "updatedByUserId" UUID,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "payroll_settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payroll_payout_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payroll_payout_batches"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payroll_input_consumptions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payroll_exceptions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payroll_run_stage_actors"`);
    await queryRunner.query(`ALTER TABLE "payroll_compensations" DROP COLUMN "reason"`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_payroll_periods_overlap" ON "payroll_periods"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS payroll_periods_check_overlap()`);
    await queryRunner.query(`ALTER TABLE "payroll_periods" DROP CONSTRAINT "CHK_payroll_periods_range"`);
    await queryRunner.query(`ALTER TABLE "payroll_periods" DROP COLUMN "closedAt", DROP COLUMN "closedByUserId"`);
    await queryRunner.query(`ALTER TABLE "payroll_run_lines" DROP COLUMN "adjustmentsAmount"`);
    await queryRunner.query(`DROP INDEX "UQ_payroll_runs_period_open_supplementary"`);
    await queryRunner.query(`DROP INDEX "UQ_payroll_runs_period_active_regular"`);
    await queryRunner.query(`DROP INDEX "UQ_payroll_runs_period_revision"`);
    // Restoring the single-run-per-period index is only possible when no period has more than one run.
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payroll_runs_period" ON "payroll_runs" ("payrollPeriodId")`);
    await queryRunner.query(`ALTER TABLE "payroll_runs" DROP CONSTRAINT "CHK_payroll_runs_kind"`);
    await queryRunner.query(`ALTER TABLE "payroll_runs" DROP CONSTRAINT "CHK_payroll_runs_status"`);
    await queryRunner.query(
      `ALTER TABLE "payroll_runs" ADD CONSTRAINT "CHK_payroll_runs_status" CHECK ("status" IN ('draft', 'calculated', 'reviewed', 'approved', 'posted'))`,
    );
    await queryRunner.query(`
      ALTER TABLE "payroll_runs"
        DROP COLUMN "revision", DROP COLUMN "kind", DROP COLUMN "supersedesRunId", DROP COLUMN "rejectedAt", DROP COLUMN "rejectedByUserId",
        DROP COLUMN "rejectionReason", DROP COLUMN "inputsFingerprint", DROP COLUMN "totalGross", DROP COLUMN "totalCommission",
        DROP COLUMN "totalAdjustments", DROP COLUMN "totalDeductions", DROP COLUMN "totalNet"
    `);
  }
}
