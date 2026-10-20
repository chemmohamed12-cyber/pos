import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Item Details page (2026-10-15) — labels for the inventory item click-through page (`/inventory/items/:productId`): its section
 * tabs, the fields shown from the existing data model, the "not defined in the current data model" note used for fields the
 * reference design shows but the Product model does not hold yet (item type, category, barcode, reorder level, description, image),
 * and the movement / reference types that had no label. Data only — no schema change; `down` removes exactly these rows.
 */
export class SeedItemDetailsTerminology1790014000000 implements MigrationInterface {
  name = 'SeedItemDetailsTerminology1790014000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.item_details', 'nav', 'بطاقة الصنف', 'Item details'],
    ['action.back_to_inventory', 'action', 'العودة إلى المخزون', 'Back to inventory'],
    ['action.edit_item', 'action', 'تعديل الصنف', 'Edit item'],
    ['action.open_item_details', 'action', 'فتح بطاقة الصنف', 'Open item details'],
    ['panel.item_basic_info', 'panel', 'بيانات أساسية', 'Basic information'],
    ['panel.item_warehouse_balances', 'panel', 'أرصدة المخازن', 'Warehouse balances'],
    ['panel.item_movements', 'panel', 'حركات الصنف', 'Item movements'],
    ['panel.item_units_barcodes', 'panel', 'الوحدات والباركود', 'Units and barcodes'],
    ['panel.item_costing_pricing', 'panel', 'التكلفة والتسعير', 'Costing and pricing'],
    ['panel.item_bom', 'panel', 'مكونات المنتج (BOM)', 'Bill of materials'],
    ['panel.item_no_image', 'panel', 'لا توجد صورة للصنف', 'No item image'],
    ['panel.not_in_data_model', 'panel', 'غير معرّف في نموذج البيانات الحالي', 'Not defined in the current data model'],
    ['panel.item_no_barcode_model', 'panel', 'لا يدعم النظام الباركود حاليًا — سيُضاف كقدرة مستقلة بعد اعتمادها', 'Barcodes are not supported yet — a separate capability pending approval'],
    ['panel.item_no_bom', 'panel', 'لا توجد قائمة مكونات معرّفة لهذا الصنف', 'No bill of materials is defined for this item'],
    ['panel.item_no_movements', 'panel', 'لا توجد حركات في الفترة المحددة', 'No movements in the selected period'],
    ['panel.item_no_balances', 'panel', 'لا توجد أرصدة لهذا الصنف في المخازن المتاحة لك', 'This item has no balance in the warehouses you can see'],
    ['panel.item_balances_reconciled', 'panel', 'الرصيد الختامي يطابق إجمالي أرصدة المخازن', 'Closing balance matches the total warehouse balance'],
    ['panel.item_balances_not_reconciled', 'panel', 'الرصيد الختامي لا يطابق إجمالي أرصدة المخازن', 'Closing balance does not match the total warehouse balance'],
    ['panel.item_dates_posting_time', 'panel', 'التواريخ هنا هي وقت ترحيل الحركة في دفتر المخزون', 'Dates here are the posting time of each movement in the stock ledger'],
    ['panel.item_cost_restricted', 'panel', 'عرض التكلفة يتطلب صلاحية تقييم المخزون', 'Viewing cost requires the inventory valuation permission'],
    ['field.item_type', 'field', 'نوع الصنف', 'Item type'],
    ['field.reorder_level', 'field', 'حد الطلب', 'Reorder level'],
    ['field.barcode', 'field', 'باركود', 'Barcode'],
    ['field.base_unit', 'field', 'الوحدة الأساسية', 'Base unit'],
    ['field.item_image', 'field', 'صورة الصنف', 'Item image'],
    ['field.incoming_qty', 'field', 'وارد', 'In'],
    ['field.outgoing_qty', 'field', 'منصرف', 'Out'],
    ['field.source_document', 'field', 'المستند', 'Document'],
    ['field.posting_time', 'field', 'وقت الترحيل', 'Posting time'],
    ['field.assigned_warehouses', 'field', 'المخازن المعيّن لها', 'Assigned warehouses'],
    ['field.base_price', 'field', 'السعر الأساسي', 'Base price'],
    ['field.all_visible_warehouses', 'field', 'كل المخازن المتاحة', 'All visible warehouses'],
    ['field.totals', 'field', 'الإجمالي', 'Total'],
    ['movement_type.return_in', 'movement_type', 'وارد مرتجع', 'Return in'],
    ['movement_type.work_order_material_issue', 'movement_type', 'صرف خامات لأمر تشغيل', 'Work order material issue'],
    ['movement_type.work_order_material_return', 'movement_type', 'مرتجع خامات من أمر تشغيل', 'Work order material return'],
    ['movement_type.work_order_finished_goods_output', 'movement_type', 'إنتاج تام من أمر تشغيل', 'Work order finished goods'],
    ['reference_type.warehouse_transaction', 'reference_type', 'حركة مخزنية', 'Warehouse transaction'],
    ['reference_type.goods_receipt', 'reference_type', 'استلام بضاعة', 'Goods receipt'],
    ['reference_type.sales_order', 'reference_type', 'أمر بيع', 'Sales order'],
    ['reference_type.work_order', 'reference_type', 'أمر تشغيل', 'Work order'],
    ['reference_type.assembly', 'reference_type', 'تجميع', 'Assembly'],
    ['reference_type.return', 'reference_type', 'مرتجع', 'Return'],
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
