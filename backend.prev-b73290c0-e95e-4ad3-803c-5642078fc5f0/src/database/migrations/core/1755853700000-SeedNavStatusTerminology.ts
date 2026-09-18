import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ERP Foundation P7 (Server-Driven Frontend Navigation). Terminology for the
 * sidebar's loading / error / empty states (`Layout.tsx`) — the SPA renders
 * nothing hard-coded, so these labels come from the Terminology Registry like
 * every other string (ADR-011). `core`-tagged (ADR-025) — platform chrome,
 * present on every Edition.
 */
export class SeedNavStatusTerminology1755853700000 implements MigrationInterface {
  name = 'SeedNavStatusTerminology1755853700000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['common.loading', 'field', 'جارٍ التحميل…', 'Loading…'],
    ['common.nav_unavailable', 'field', 'تعذّر تحميل القائمة', 'Navigation unavailable'],
    ['common.nav_empty', 'field', 'لا توجد عناصر متاحة', 'No items available'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.terminology) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.terminology.map(([code]) => code)]);
  }
}
