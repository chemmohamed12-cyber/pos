import { MigrationInterface, QueryRunner } from 'typeorm';

/** Warehouse & Inventory Control UX rebuild — Inventory Grid (§5/§6). */
export class SeedInventoryGridTerminology1755847200000 implements MigrationInterface {
  name = 'SeedInventoryGridTerminology1755847200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.last_movement', 'field', 'آخر حركة', 'Last Movement'],
      ['panel.no_inventory_rows', 'panel', 'لا توجد أصناف في هذا المخزن', 'No items in this warehouse yet.'],
      ['action.previous_page', 'action', 'السابق', 'Previous'],
      ['action.next_page', 'action', 'التالي', 'Next'],
      ['field.page_of_total', 'field', 'صفحة {page} من {total}', 'Page {page} of {total}'],
      ['action.view_inventory', 'action', 'عرض المخزون', 'View Inventory'],
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
      'field.last_movement', 'panel.no_inventory_rows', 'action.previous_page',
      'action.next_page', 'field.page_of_total', 'action.view_inventory',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
