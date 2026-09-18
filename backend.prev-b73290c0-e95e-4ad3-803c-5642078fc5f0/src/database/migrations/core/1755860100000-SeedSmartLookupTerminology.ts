import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Platform-wide Smart Lookup UX initiative (Global UX Audit directive) —
 * the shared `<SmartLookup>` combobox (`frontend/src/components/
 * SmartLookup.tsx`) replaces raw UUID/code text inputs across the app.
 * These are its own chrome strings (loading/empty/error states, the
 * clear button), not tied to any one entity, so every screen that adopts
 * the component reuses this same handful of codes.
 */
export class SeedSmartLookupTerminology1755860100000 implements MigrationInterface {
  name = 'SeedSmartLookupTerminology1755860100000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['action.clear', 'action', 'مسح', 'Clear'],
    ['panel.smart_lookup_loading', 'panel', 'جارٍ البحث…', 'Searching…'],
    ['panel.smart_lookup_error', 'panel', 'تعذر تحميل النتائج', 'Failed to load results'],
    ['panel.smart_lookup_empty', 'panel', 'لا توجد نتائج', 'No results'],
    ['panel.smart_lookup_placeholder', 'panel', 'ابحث بالاسم أو الكود…', 'Search by name or code…'],
    ['panel.smart_lookup_placeholder_optional', 'panel', 'ابحث بالاسم أو الكود… (اختياري)', 'Search by name or code… (optional)'],
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
