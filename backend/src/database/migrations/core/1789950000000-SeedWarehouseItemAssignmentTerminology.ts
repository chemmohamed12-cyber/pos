import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D1 (2026-10-05) — Inventory screen: the item scope switch (assigned / all), the Assigned indicator and the assign / remove
 * actions. Same idempotent seed shape as every other terminology migration.
 */
export class SeedWarehouseItemAssignmentTerminology1789950000000 implements MigrationInterface {
  name = 'SeedWarehouseItemAssignmentTerminology1789950000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['field.item_scope', 'field', 'نطاق الأصناف', 'Items shown'],
    ['value.item_scope.assigned', 'value', 'أصناف هذا المخزن (الافتراضية + التي بها رصيد)', 'This warehouse\'s items (default + holding stock)'],
    ['value.item_scope.all', 'value', 'كل الأصناف', 'All items'],
    ['field.assigned', 'field', 'مخزن افتراضي/ابتدائي', 'Default / origin'],
    ['value.assigned.yes', 'value', 'افتراضي', 'Default'],
    ['value.assigned.no', 'value', 'به رصيد (ليس افتراضيًا)', 'Holds stock (not the default)'],
    ['panel.assign_item_to_warehouse', 'panel', 'تعيين صنف كافتراضي لهذا المخزن', 'Set an item\'s default warehouse to this one'],
    ['action.remove_from_warehouse', 'action', 'إزالة الوضع الافتراضي', 'Remove the default marker'],
    ['field.default_warehouse', 'field', 'المخزن الابتدائي/الافتراضي', 'Initial / default warehouse'],
  ];

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
