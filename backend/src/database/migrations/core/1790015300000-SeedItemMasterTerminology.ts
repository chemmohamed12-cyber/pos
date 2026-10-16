import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Master data step 1 (approved 2026-10-15) — labels for the editable item page: item type values (D-MD2), category, primary
 * default warehouse, reorder level hint, description, barcodes (D-MD11) and the integer-BOM note (D-MD5). Data only; every code
 * is new (checked against all existing seeds), so `ON CONFLICT` never rewrites an existing label; `down` removes exactly these.
 */
export class SeedItemMasterTerminology1790015300000 implements MigrationInterface {
  name = 'SeedItemMasterTerminology1790015300000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['value.item_type.finished_good', 'item_type', 'منتج تام', 'Finished good'],
    ['value.item_type.semi_finished', 'item_type', 'منتج نصف مصنّع', 'Semi-finished good'],
    ['value.item_type.raw_material', 'item_type', 'مادة خام', 'Raw material'],
    ['value.item_type.consumable', 'item_type', 'مستلزمات تشغيل', 'Consumable'],
    ['value.item_type.service', 'item_type', 'خدمة', 'Service'],
    ['field.item_category', 'field', 'فئة الصنف', 'Category'],
    ['field.primary_default_warehouse', 'field', 'المخزن الافتراضي', 'Default warehouse'],
    ['field.item_description', 'field', 'وصف الصنف', 'Description'],
    ['field.category_code', 'field', 'كود الفئة', 'Category code'],
    ['field.category_name', 'field', 'اسم الفئة', 'Category name'],
    ['action.new_category', 'action', 'فئة جديدة', 'New category'],
    ['panel.item_default_warehouse_hint', 'panel', 'يُختار من المخازن المعيّن لها الصنف', 'Chosen among the warehouses the item is assigned to'],
    ['panel.item_reorder_hint', 'panel', 'بالوحدة الأساسية — يظهر تنبيه عندما يصل المتاح إليه أو أقل', 'In the base unit — a warning shows when available stock reaches it'],
    ['panel.item_saved', 'panel', 'تم حفظ بيانات الصنف', 'Item saved'],
    ['panel.item_below_reorder', 'panel', 'وصل إلى حد الطلب', 'At or below reorder level'],
    ['field.pack_label', 'field', 'وصف العبوة', 'Pack label'],
    ['field.primary_barcode', 'field', 'أساسي', 'Primary'],
    ['action.add_barcode', 'action', 'إضافة باركود', 'Add barcode'],
    ['panel.item_no_barcodes', 'panel', 'لا توجد باركودات لهذا الصنف', 'This item has no barcodes'],
    [
      'panel.item_barcode_rules',
      'panel',
      'الباركود فريد على مستوى الشركة ولا يساوي كود أي صنف. وصف العبوة للعرض فقط ولا يحوّل الكميات.',
      'A barcode is unique in the company and never equals an item code. The pack label is descriptive only — it does not convert quantities.',
    ],
    [
      'panel.item_bom_integer_note',
      'panel',
      'الكميات أعداد صحيحة (1 أو أكثر) بالوحدة الأساسية لكل مكوّن.',
      'Quantities are whole numbers (1 or more) in each component’s base unit.',
    ],
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
