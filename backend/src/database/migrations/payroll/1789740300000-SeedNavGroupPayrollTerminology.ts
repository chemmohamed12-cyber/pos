import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Navigation Root-Cause Fix (2026-09-26, CTO-authorized — "Full Navigation
 * Closure"). Same gap `SeedNavGroupHrTerminology1755854300000` fixed for
 * `nav_group.hr`: every nav ITEM under `payroll` already has seeded
 * terminology (`SeedPayrollPhase1Terminology`), but the nav GROUP label
 * itself, `nav_group.payroll`, was never seeded — confirmed absent
 * anywhere in migration history before this file.
 */
export class SeedNavGroupPayrollTerminology1789740300000 implements MigrationInterface {
  name = 'SeedNavGroupPayrollTerminology1789740300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
       VALUES ('nav_group.payroll', 'nav', 'الرواتب', 'Payroll')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = 'nav_group.payroll'`);
  }
}
