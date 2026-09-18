import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `accounting`-tagged (ADR-025). Follow-up to `SeedFiscalClosingTerminology1789622214177`
 * — one panel label that migration's own `AccountingSettings.tsx` wiring needs
 * (a shared success message for the three F13 FA-01 submit actions: fiscal
 * year close, fiscal period close, fiscal period reopen). Same idempotent
 * (`ON CONFLICT`) shape as every other terminology seed.
 */
export class SeedFiscalClosingPanelTerminology1789622332654 implements MigrationInterface {
  name = 'SeedFiscalClosingPanelTerminology1789622332654';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
       VALUES ('panel.fiscal_closing_submitted_approval', 'field', 'تم تقديم الطلب للاعتماد (صانع/مراجع)', 'Submitted for approval (maker-checker)')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = 'panel.fiscal_closing_submitted_approval'`);
  }
}
