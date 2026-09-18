import { MigrationInterface, QueryRunner } from 'typeorm';

/** Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16) — UI labels for the new `/shipment-returns` and `/sales-returns` screens. */
export class SeedShipmentAndSalesReturnsTerminology1755863300000 implements MigrationInterface {
  name = 'SeedShipmentAndSalesReturnsTerminology1755863300000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['nav.shipment_returns', 'field', 'مرتجعات الشحن', 'Shipment Returns'],
    ['nav.sales_returns', 'field', 'مرتجعات المبيعات', 'Sales Returns'],
    ['panel.no_shipment_returns_yet', 'panel', 'لا توجد مرتجعات شحن بعد', 'No shipment returns yet'],
    ['panel.no_sales_returns_yet', 'panel', 'لا توجد مرتجعات مبيعات بعد', 'No sales returns yet'],
    ['field.shipment', 'field', 'الشحنة', 'Shipment'],
    ['field.shipment_items', 'field', 'محتويات الشحنة', 'Shipment Items'],
    ['field.return_mode', 'field', 'نوع الإرجاع', 'Return Mode'],
    ['return_mode.full', 'field', 'إرجاع كامل', 'Full Return'],
    ['return_mode.partial', 'field', 'إرجاع جزئي', 'Partial Return'],
    ['field.return_amount', 'field', 'قيمة المرتجع', 'Return Amount'],
    ['field.shipped_quantity', 'field', 'الكمية المشحونة', 'Shipped Quantity'],
    ['field.return_quantity', 'field', 'كمية المرتجع', 'Return Quantity'],
    ['field.return_price', 'field', 'سعر المرتجع', 'Return Price'],
    ['field.item_total', 'field', 'إجمالي الصنف', 'Item Total'],
    ['field.total_return_amount', 'field', 'إجمالي قيمة المرتجع', 'Total Return Amount'],
    ['field.order_scope', 'field', 'نطاق الأوردر', 'Order Scope'],
    ['order_scope.specific', 'field', 'أوردر محدد', 'Specific Order'],
    ['order_scope.all_orders', 'field', 'كل الأوردرات', 'All Orders'],
    ['field.available_quantity', 'field', 'الكمية المتاحة', 'Available Quantity'],
    ['field.return_date', 'field', 'تاريخ المرتجع', 'Return Date'],
    ['field.source_orders', 'field', 'الأوردرات المصدر', 'Source Orders'],
    ['action.add_item', 'action', 'إضافة صنف', 'Add Item'],
    ['action.create_shipment_return', 'action', 'إنشاء مرتجع شحنة', 'Create Shipment Return'],
    ['action.view_details', 'action', 'عرض التفاصيل', 'View Details'],
    ['action.complete', 'action', 'إتمام', 'Complete'],
    ['shipment_return.state.requested', 'field', 'مطلوب', 'Requested'],
    ['shipment_return.state.completed', 'field', 'مكتمل', 'Completed'],
    ['shipment_return.state.rejected', 'field', 'مرفوض', 'Rejected'],
    ['sales_return.state.requested', 'field', 'مطلوب', 'Requested'],
    ['sales_return.state.completed', 'field', 'مكتمل', 'Completed'],
    ['sales_return.state.rejected', 'field', 'مرفوض', 'Rejected'],
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
