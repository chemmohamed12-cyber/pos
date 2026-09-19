import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-065 (Attendance Phase 1) — the full Foundation + Processing +
 * Approval data model in one migration, entirely additive (no existing
 * HR or Attendance-adjacent table is touched). `attendance_days.status`
 * is fixed to exactly four values per ratified `ADR-063 §1: C` + `§7: B`
 * — `late`/`early_departure`/`holiday` are never introduced.
 *
 * The `(connectorId, deviceUserRef)` partial-unique index on
 * `attendance_employee_mappings` — "exactly one ACTIVE mapping per
 * device-side identifier at a time" (`ADR-062 §5`) — is expressed here
 * as a real Postgres partial index (`WHERE "effectiveTo" IS NULL`),
 * since TypeORM's own decorator syntax cannot express a partial unique
 * constraint.
 */
export class CreateAttendanceCore1789730000000 implements MigrationInterface {
  name = 'CreateAttendanceCore1789730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "attendance_connectors" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "connectorType" VARCHAR(32) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
        "config" JSONB NOT NULL DEFAULT '{}',
        "lastConnectedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_attendance_connectors_connectorType" ON "attendance_connectors" ("connectorType")`);

    await queryRunner.query(`
      CREATE TABLE "attendance_employee_mappings" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "connectorId" UUID NOT NULL,
        "employeeId" UUID NOT NULL,
        "deviceUserRef" VARCHAR(128) NOT NULL,
        "effectiveFrom" TIMESTAMPTZ NOT NULL,
        "effectiveTo" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_attendance_mappings_connector_employee" ON "attendance_employee_mappings" ("connectorId", "employeeId")`);
    await queryRunner.query(`CREATE INDEX "IDX_attendance_mappings_connectorId" ON "attendance_employee_mappings" ("connectorId")`);
    await queryRunner.query(`CREATE INDEX "IDX_attendance_mappings_employeeId" ON "attendance_employee_mappings" ("employeeId")`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_attendance_mappings_active_device_ref"
      ON "attendance_employee_mappings" ("connectorId", "deviceUserRef")
      WHERE "effectiveTo" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "attendance_import_batches" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "fileHash" VARCHAR(64) NOT NULL,
        "fileName" VARCHAR(255) NOT NULL,
        "totalRows" INT NOT NULL,
        "succeededCount" INT NOT NULL,
        "rejectedCount" INT NOT NULL,
        "importedByUserId" UUID NOT NULL,
        "importedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_attendance_import_batches_fileHash" ON "attendance_import_batches" ("fileHash")`);

    await queryRunner.query(`
      CREATE TABLE "attendance_raw_records" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "sourceType" VARCHAR(16) NOT NULL,
        "sourceConnectorId" UUID,
        "importBatchId" UUID,
        "deviceEmployeeRef" VARCHAR(128) NOT NULL,
        "resolvedEmployeeId" UUID,
        "punchTimestamp" TIMESTAMPTZ NOT NULL,
        "punchType" VARCHAR(16) NOT NULL,
        "rawPayload" JSONB,
        "ingestedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "ingestedByUserId" UUID,
        CONSTRAINT "CHK_attendance_raw_records_sourceType" CHECK ("sourceType" IN ('manual', 'excel_import', 'api')),
        CONSTRAINT "CHK_attendance_raw_records_punchType" CHECK ("punchType" IN ('in', 'out', 'unknown'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_attendance_raw_records_resolved_ts" ON "attendance_raw_records" ("resolvedEmployeeId", "punchTimestamp")`);
    await queryRunner.query(`CREATE INDEX "IDX_attendance_raw_records_importBatchId" ON "attendance_raw_records" ("importBatchId")`);

    await queryRunner.query(`
      CREATE TABLE "attendance_approval_batches" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "periodStart" DATE NOT NULL,
        "periodEnd" DATE NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
        "approvalRequestId" UUID,
        "createdByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "decidedAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_attendance_approval_batches_status" CHECK ("status" IN ('draft', 'submitted', 'approved', 'rejected'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_attendance_approval_batches_approvalRequestId" ON "attendance_approval_batches" ("approvalRequestId")`);

    await queryRunner.query(`
      CREATE TABLE "attendance_days" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "employeeId" UUID NOT NULL,
        "calendarDate" DATE NOT NULL,
        "checkIn" TIMESTAMPTZ,
        "checkOut" TIMESTAMPTZ,
        "hoursWorked" NUMERIC(8,4),
        "status" VARCHAR(16) NOT NULL,
        "batchId" UUID,
        "correctedByUserId" UUID,
        "correctedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_attendance_days_status" CHECK ("status" IN ('present', 'absent', 'on_leave', 'missing_punch'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_attendance_days_employee_date" ON "attendance_days" ("employeeId", "calendarDate")`);
    await queryRunner.query(`CREATE INDEX "IDX_attendance_days_employeeId" ON "attendance_days" ("employeeId")`);
    await queryRunner.query(`CREATE INDEX "IDX_attendance_days_batchId" ON "attendance_days" ("batchId")`);

    await queryRunner.query(`
      CREATE TABLE "attendance_correction_requests" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "attendanceDayId" UUID NOT NULL,
        "approvalRequestId" UUID NOT NULL,
        "proposedCheckIn" TIMESTAMPTZ,
        "proposedCheckOut" TIMESTAMPTZ,
        "reason" TEXT NOT NULL,
        "requestedByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_attendance_correction_requests_attendanceDayId" ON "attendance_correction_requests" ("attendanceDayId")`);
    await queryRunner.query(`CREATE INDEX "IDX_attendance_correction_requests_approvalRequestId" ON "attendance_correction_requests" ("approvalRequestId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "attendance_correction_requests"`);
    await queryRunner.query(`DROP TABLE "attendance_days"`);
    await queryRunner.query(`DROP TABLE "attendance_approval_batches"`);
    await queryRunner.query(`DROP TABLE "attendance_raw_records"`);
    await queryRunner.query(`DROP TABLE "attendance_import_batches"`);
    await queryRunner.query(`DROP TABLE "attendance_employee_mappings"`);
    await queryRunner.query(`DROP TABLE "attendance_connectors"`);
  }
}
