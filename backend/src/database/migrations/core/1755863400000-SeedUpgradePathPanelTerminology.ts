import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Release Engine overhaul, stage 4 (Release Center UI) — the Upgrade Path
 * panel on `ReleaseCenter.tsx` needs a few more field labels beyond the
 * `field.upgrade_path` title seeded by `SeedUpgradePathTerminology`
 * (1755863000000). Same INSERT-with-ON-CONFLICT pattern as every other
 * terminology seed migration in this file.
 */
export class SeedUpgradePathPanelTerminology1755863400000 implements MigrationInterface {
  name = 'SeedUpgradePathPanelTerminology1755863400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['action.check_upgrade_path', 'action', 'فحص مسار الترقية', 'Check Upgrade Path'],
      ['field.upgrade_path_reachable', 'field', 'قابل للترقية', 'Reachable'],
      ['field.upgrade_path_unreachable', 'field', 'غير قابل للترقية', 'Not Reachable'],
      ['field.upgrade_path_chain', 'field', 'سلسلة الترقية', 'Upgrade Chain'],
      ['panel.no_upgrade_path_checked', 'panel', 'لم يتم الفحص بعد', 'Not checked yet'],
    ];
    for (const [code, category, ar, en] of seed) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const codes = [
      'action.check_upgrade_path',
      'field.upgrade_path_reachable',
      'field.upgrade_path_unreachable',
      'field.upgrade_path_chain',
      'panel.no_upgrade_path_checked',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
