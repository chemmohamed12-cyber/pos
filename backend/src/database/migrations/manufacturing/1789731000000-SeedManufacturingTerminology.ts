import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-061 §18 — terminology for the Manufacturing frontend (WorkOrders,
 * WorkOrderDetail, ManufacturingCover). Only codes that do NOT already
 * exist elsewhere in the codebase are seeded here (`field.warehouse`,
 * `field.status`, `field.actions`, `field.created_at`, `field.component`,
 * `field.finished_product`, `field.quantity_remaining`, `action.back`,
 * `action.confirm` already exist and are reused unmodified — verified by
 * direct query before writing this migration).
 */
export class SeedManufacturingTerminology1789731000000 implements MigrationInterface {
  name = 'SeedManufacturingTerminology1789731000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['module.manufacturing', 'field', 'التصنيع', 'Manufacturing'],
    ['nav.manufacturing_work_orders', 'field', 'أوامر الإنتاج', 'Work Orders'],
    ['field.work_order_number', 'field', 'رقم أمر الإنتاج', 'Work Order Number'],
    ['field.quantity_planned', 'field', 'الكمية المخططة', 'Quantity Planned'],
    ['field.quantity_produced', 'field', 'الكمية المنتجة', 'Quantity Produced'],
    ['field.quantity_required', 'field', 'الكمية المطلوبة', 'Quantity Required'],
    ['field.quantity_issued', 'field', 'الكمية المصروفة', 'Quantity Issued'],
    ['field.wip_value', 'field', 'قيمة الإنتاج تحت التشغيل', 'WIP Value'],
    ['field.total_work_orders', 'field', 'إجمالي أوامر الإنتاج', 'Total Work Orders'],
    ['field.open_work_orders', 'field', 'أوامر الإنتاج المفتوحة', 'Open Work Orders'],
    ['action.create_work_order', 'field', 'إنشاء أمر إنتاج', 'Create Work Order'],
    ['action.view', 'field', 'عرض', 'View'],
    ['action.material_issue', 'field', 'صرف مواد', 'Material Issue'],
    ['action.material_return', 'field', 'إرجاع مواد', 'Material Return'],
    ['action.finished_goods_output', 'field', 'استلام منتج تام', 'Finished Goods Output'],
    ['panel.no_work_orders_yet', 'panel', 'لا توجد أوامر إنتاج بعد', 'No work orders yet'],
    ['work_order_action.release', 'field', 'إصدار', 'Release'],
    ['work_order_action.cancel', 'field', 'إلغاء', 'Cancel'],
    ['work_order_action.hold', 'field', 'إيقاف مؤقت', 'Hold'],
    ['work_order_action.resume', 'field', 'استئناف', 'Resume'],
    ['work_order_action.complete', 'field', 'إكمال', 'Complete'],
    ['work_order_lifecycle.state.draft', 'field', 'مسودة', 'Draft'],
    ['work_order_lifecycle.state.released', 'field', 'تم الإصدار', 'Released'],
    ['work_order_lifecycle.state.in_progress', 'field', 'قيد التنفيذ', 'In Progress'],
    ['work_order_lifecycle.state.on_hold', 'field', 'متوقف مؤقتًا', 'On Hold'],
    ['work_order_lifecycle.state.completed', 'field', 'مكتمل', 'Completed'],
    ['work_order_lifecycle.state.cancelled', 'field', 'ملغى', 'Cancelled'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const values = this.rows
      .map(([code, category, ar, en]) => `('${code}', '${category}', '${ar.replace(/'/g, "''")}', '${en.replace(/'/g, "''")}')`)
      .join(',\n       ');
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES
       ${values}
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const codes = this.rows.map(([code]) => `'${code}'`).join(', ');
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code IN (${codes})`);
  }
}
