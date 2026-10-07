import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Authorization Foundation F2 (2026-10-07): the sidebar label of the new Company Users screen. Idempotent upsert.
 * (The screen's own texts are bilingual in the page, like the Login and control-plane screens.)
 */
export class SeedCompanyUsersTerminology1790004000000 implements MigrationInterface {
  name = 'SeedCompanyUsersTerminology1790004000000';

  private readonly rows: Array<[string, string, string, string]> = [['nav.company_users', 'nav', 'مستخدمو الشركة', 'Company users']];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
