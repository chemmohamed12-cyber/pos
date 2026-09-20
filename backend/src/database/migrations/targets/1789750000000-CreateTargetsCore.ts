import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-071 §4/§E — Target Management, its own independent bounded context
 * (ADR-068 §D). `targets` is a genuinely new module code, never
 * previously reserved (confirmed `module-manifest.type.ts`), the same
 * situation `attendance` was in — not a promotion.
 *
 * Non-overlap (ADR-068 §E's ratified requirement) is enforced with a real
 * Postgres EXCLUDE constraint — no two `approved` Targets for the same
 * employee may have overlapping date ranges. This is a genuinely new
 * pattern for this codebase (no prior EXCLUDE-constraint use found), the
 * correct native mechanism for this specific invariant — stronger than
 * the partial-unique-index pattern `attendance_employee_mappings`/
 * `payroll_compensations` use (which only prevents more than one
 * *currently active* row, not overlapping *date ranges*).
 */
export class CreateTargetsCore1789750000000 implements MigrationInterface {
  name = 'CreateTargetsCore1789750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // btree_gist is required for a GiST exclusion constraint mixing an equality
    // column (employeeId) with a range-overlap column (the daterange) — Postgres
    // core only ships gist range-overlap operators, not gist equality, without it.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

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
    // Draft/pending/rejected rows are excluded from this constraint by design (only an
    // approved target is a binding commitment two ranges could genuinely conflict over).
    await queryRunner.query(`
      ALTER TABLE "targets"
      ADD CONSTRAINT "EXCL_targets_employee_period_when_approved"
      EXCLUDE USING gist (
        "employeeId" WITH =,
        daterange("periodStart", "periodEnd", '[]') WITH &&
      )
      WHERE ("status" = 'approved')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "targets"`);
  }
}
