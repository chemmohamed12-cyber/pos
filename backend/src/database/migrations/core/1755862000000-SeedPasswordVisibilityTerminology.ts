import { MigrationInterface, QueryRunner } from 'typeorm';

/** Platform UX Improvement Track, Item 2 (2026-09-12) — show/hide password toggle, accessible label terminology. */
export class SeedPasswordVisibilityTerminology1755862000000 implements MigrationInterface {
  name = 'SeedPasswordVisibilityTerminology1755862000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['action.show_password', 'action', 'إظهار كلمة المرور', 'Show password'],
      ['action.hide_password', 'action', 'إخفاء كلمة المرور', 'Hide password'],
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
    const codes = ['action.show_password', 'action.hide_password'];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
