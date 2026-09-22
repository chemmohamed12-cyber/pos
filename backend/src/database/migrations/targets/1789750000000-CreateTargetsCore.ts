import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-071 §4/§E — Target Management, its own independent bounded context
 * (ADR-068 §D). `targets` is a genuinely new module code, never
 * previously reserved (confirmed `module-manifest.type.ts`), the same
 * situation `attendance` was in — not a promotion.
 *
 * Non-overlap (ADR-068 §E's ratified requirement) — no two `approved`
 * Targets for the same employee may have overlapping date ranges — is
 * enforced at the DB level via a `BEFORE INSERT OR UPDATE` trigger, not
 * a Postgres EXCLUDE constraint. An EXCLUDE constraint mixing an
 * equality column with a range-overlap column needs the `btree_gist`
 * extension (GiST core alone has no equality operator class), and
 * `PRODUCTION_DEPLOYMENT_GUIDE.md`'s own "UUID generation strategy" /
 * "Rule for future migrations" section — written after the 2026-08-27
 * production incident — is explicit: **no migration may ever run
 * `CREATE EXTENSION` for anything**, because this codebase's actual
 * Hosting target (Namecheap Shared Stellar Plus) has zero contrib
 * extensions available (confirmed live: `pgcrypto`/`uuid-ossp` both
 * missing `.control` files, not a permissions restriction — `btree_gist`
 * is the same class of contrib module and was never independently
 * re-confirmed). Found and corrected during this release's own
 * candidate review, before this migration ever reached a real Hosting
 * target (caught by design — see the restored
 * `extension-dependencies.spec.ts` regression guard).
 *
 * The trigger function reproduces the EXACT same invariant an EXCLUDE
 * constraint would (atomic, race-safe, DB-level, `status='approved'`
 * rows only) using only core SQL: `daterange`/`&&` are core Postgres
 * types/operators (no extension needed for the comparison itself — only
 * the *indexed* EXCLUDE-constraint mechanism needed GiST+btree_gist), and
 * `pg_advisory_xact_lock` (also core) serializes concurrent approval
 * attempts for the same employee so two concurrent transactions can
 * never both pass the overlap check before either commits — the same
 * "read-then-decide, but race-safe" pattern `NumberingService.
 * getNextNumber`'s own `SELECT ... FOR UPDATE` and `PayrollService.
 * disburse`'s own `pg_advisory_xact_lock` already use elsewhere in this
 * codebase.
 */
export class CreateTargetsCore1789750000000 implements MigrationInterface {
  name = 'CreateTargetsCore1789750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "targets" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "employeeId" UUID NOT NULL,
        "periodStart" DATE NOT NULL,
        "periodEnd" DATE NOT NULL,
        "targetValue" NUMERIC(14,2) NOT NULL,
        "teamId" UUID,
        "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
        "approvalRequestId" UUID,
        "createdByUserId" UUID NOT NULL,
        "approvedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_targets_status" CHECK ("status" IN ('draft', 'pending_approval', 'approved', 'rejected')),
        CONSTRAINT "CHK_targets_period" CHECK ("periodStart" <= "periodEnd")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_targets_employeeId" ON "targets" ("employeeId")`);

    // ADR-068 §E — no two APPROVED targets for the same employee may overlap in period.
    // Draft/pending/rejected rows are excluded from this check by design (only an
    // approved target is a binding commitment two ranges could genuinely conflict over).
    // The error text/ERRCODE mirror what an EXCLUDE constraint itself would have raised
    // (23P01, exclusion_violation) — no caller-visible behavior change from the original design.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION targets_check_non_overlap() RETURNS TRIGGER AS $BODY$
      BEGIN
        IF NEW."status" = 'approved' THEN
          PERFORM pg_advisory_xact_lock(hashtext('targets:employee:' || NEW."employeeId"::text));
          IF EXISTS (
            SELECT 1 FROM "targets"
            WHERE "employeeId" = NEW."employeeId"
              AND "status" = 'approved'
              AND "id" <> NEW."id"
              AND daterange("periodStart", "periodEnd", '[]') && daterange(NEW."periodStart", NEW."periodEnd", '[]')
          ) THEN
            RAISE EXCEPTION 'conflicting key value violates exclusion constraint "EXCL_targets_employee_period_when_approved"' USING ERRCODE = '23P01';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $BODY$ LANGUAGE plpgsql
    `);
    // `EXECUTE PROCEDURE`, not the newer `EXECUTE FUNCTION` spelling
    // (PG11+ only) — this project's target hosting Postgres version is
    // older than 11, where `EXECUTE FUNCTION` is a syntax error.
    // `EXECUTE PROCEDURE` invokes a trigger function identically on every
    // Postgres version back to trigger support itself, and remains valid
    // (kept for backward compatibility) on every version up to current —
    // there is no version where this spelling doesn't work.
    await queryRunner.query(`
      CREATE TRIGGER "TRG_targets_check_non_overlap"
      BEFORE INSERT OR UPDATE ON "targets"
      FOR EACH ROW EXECUTE PROCEDURE targets_check_non_overlap()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "targets"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS targets_check_non_overlap()`);
  }
}
