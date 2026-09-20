import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO directive (2026-09-20) — the confirmed real biometric device export
 * is a Daily Attendance Summary, not a raw punch-log. Entirely additive:
 * one new table (`attendance_biometric_daily_facts`) plus widening
 * `attendance_raw_records.sourceType`'s existing CHECK constraint to
 * accept `'biometric'` alongside the three values `ADR-065` already
 * shipped. No existing row, column, or ratified `ADR-063` status value is
 * touched.
 */
export class AddBiometricDailySummaryImport1789730300000 implements MigrationInterface {
  name = 'AddBiometricDailySummaryImport1789730300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "attendance_raw_records" DROP CONSTRAINT "CHK_attendance_raw_records_sourceType"`);
    await queryRunner.query(
      `ALTER TABLE "attendance_raw_records" ADD CONSTRAINT "CHK_attendance_raw_records_sourceType" CHECK ("sourceType" IN ('manual', 'excel_import', 'api', 'biometric'))`,
    );

    await queryRunner.query(`
      CREATE TABLE "attendance_biometric_daily_facts" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "importBatchId" UUID,
        "deviceUserRef" VARCHAR(128) NOT NULL,
        "sourceName" VARCHAR(255),
        "calendarDate" DATE NOT NULL,
        "resolvedEmployeeId" UUID,
        "sourceConnectorId" UUID,
        "onDuty" VARCHAR(8),
        "offDuty" VARCHAR(8),
        "clockIn" VARCHAR(8),
        "clockOut" VARCHAR(8),
        "lateValue" VARCHAR(32),
        "earlyValue" VARCHAR(32),
        "otTimeValue" VARCHAR(32),
        "sourceAbsent" BOOLEAN,
        "rawPayload" JSONB NOT NULL,
        "ingestedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "ingestedByUserId" UUID,
        "updatedAt" TIMESTAMPTZ
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_attendance_biometric_facts_ref_date" ON "attendance_biometric_daily_facts" ("deviceUserRef", "calendarDate")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_attendance_biometric_facts_importBatchId" ON "attendance_biometric_daily_facts" ("importBatchId")`);
    await queryRunner.query(`CREATE INDEX "IDX_attendance_biometric_facts_resolvedEmployeeId" ON "attendance_biometric_daily_facts" ("resolvedEmployeeId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "attendance_biometric_daily_facts"`);
    await queryRunner.query(`ALTER TABLE "attendance_raw_records" DROP CONSTRAINT "CHK_attendance_raw_records_sourceType"`);
    await queryRunner.query(
      `ALTER TABLE "attendance_raw_records" ADD CONSTRAINT "CHK_attendance_raw_records_sourceType" CHECK ("sourceType" IN ('manual', 'excel_import', 'api'))`,
    );
  }
}
