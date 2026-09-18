import { MigrationInterface, QueryRunner } from 'typeorm';

/** Release Engine overhaul, stage 4 (Release Center UI) — Upgrade Resolver result panel on ReleaseCenter.tsx. */
export class SeedUpgradePathTerminology1755863000000 implements MigrationInterface {
  name = 'SeedUpgradePathTerminology1755863000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [['field.upgrade_path', 'field', 'مسار الترقية', 'Upgrade Path']];
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
    const codes = ['field.upgrade_path'];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
