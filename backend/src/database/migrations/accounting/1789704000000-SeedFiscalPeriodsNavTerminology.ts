import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `accounting`-tagged (ADR-025). Frontend Gap Closure (2026-09-19) —
 * Fiscal Period / Month-End Closing's own dedicated sidebar entry
 * (`FiscalPeriods.tsx`, extracted from `AccountingSettings.tsx`). Every
 * other label the new page uses (`field.fiscal_year`,
 * `action.submit_period_close`, `value.fiscal_period_status.*`, etc.) was
 * already seeded when the Fiscal Year/Period UI first shipped inside
 * Settings — only the new nav label is new. Same idempotent
 * (`ON CONFLICT`) shape as every other terminology seed.
 */
export class SeedFiscalPeriodsNavTerminology1789704000000 implements MigrationInterface {
  name = 'SeedFiscalPeriodsNavTerminology1789704000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
       VALUES ('nav.fiscal_periods', 'field', 'الفترات المالية', 'Fiscal Periods')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = 'nav.fiscal_periods'`);
  }
}
