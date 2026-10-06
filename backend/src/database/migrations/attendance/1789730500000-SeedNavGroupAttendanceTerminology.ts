import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Navigation Root-Cause Fix (2026-09-26, CTO-authorized — "Full Navigation
 * Closure"). Same gap `SeedNavGroupHrTerminology1755854300000` fixed for
 * `nav_group.hr`: every nav ITEM under `attendance` already has seeded
 * terminology (`SeedAttendancePhase1Terminology`,
 * `SeedBiometricDailySummaryTerminology`), but the nav GROUP label itself,
 * `nav_group.attendance`, was never seeded — confirmed absent anywhere in
 * migration history before this file. A new migration, not an edit to an
 * already-applied one, per this codebase's standing discipline.
 */
export class SeedNavGroupAttendanceTerminology1789730500000 implements MigrationInterface {
  name = 'SeedNavGroupAttendanceTerminology1789730500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
       VALUES ('nav_group.attendance', 'nav', 'الحضور والانصراف', 'Attendance')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = 'nav_group.attendance'`);
  }
}
