import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fix-forward, not a duplicate schema change (Global UX Audit directive
 * §3 — verify schema/migration/code state before touching migrations
 * again). `1755860200000-AddGlAccountNameAr` was already recorded as
 * executed (a concurrent session's dev server auto-ran pending
 * migrations) by the time `field.account_name_ar`'s terminology INSERT
 * was added to that migration's `up()` — TypeORM never re-runs a
 * migration whose name is already in the `migrations` table, so that row
 * never landed. Confirmed via `information_schema.columns` (nameAr
 * exists) and a direct `terminology_entries` query (this code was
 * missing) before writing this. The `ADD COLUMN` itself is NOT repeated
 * here — only the missing, idempotent (`ON CONFLICT`) terminology seed.
 */
export class SeedGlAccountNameArTerminology1755860300000 implements MigrationInterface {
  name = 'SeedGlAccountNameArTerminology1755860300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
       VALUES ('field.account_name_ar', 'field', 'اسم الحساب (عربي)', 'Account Name (Arabic)')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = 'field.account_name_ar'`);
  }
}
