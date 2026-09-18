import { MigrationInterface, QueryRunner } from 'typeorm';

/** `procurement`-tagged (ADR-025). Purchase Order / Goods Receipt UI/API strings. */
export class SeedPurchaseOrderTerminology1789700500000 implements MigrationInterface {
  name = 'SeedPurchaseOrderTerminology1789700500000';

  // `field.warehouse`, `field.total_amount`, `field.line_total`, `field.notes`
  // and `action.cancel` already exist (core/finance seeds) with matching
  // wording — reused as-is in the frontend, not re-seeded here to avoid an
  // `ON CONFLICT DO UPDATE` touching unrelated screens. `action.add_line`
  // already exists with THREE different wordings across older seeds — this
  // domain deliberately does not reuse that ambiguous code (see below).
  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.purchase_orders', 'field', 'أوامر الشراء', 'Purchase Orders'],
    ['field.po_number', 'field', 'رقم أمر الشراء', 'PO Number'],
    ['field.gr_number', 'field', 'رقم إذن الاستلام', 'GR Number'],
    ['field.unit_cost', 'field', 'سعر الوحدة', 'Unit Cost'],
    ['field.quantity_ordered', 'field', 'الكمية المطلوبة', 'Quantity Ordered'],
    ['field.quantity_received', 'field', 'الكمية المستلمة', 'Quantity Received'],
    ['field.quantity_remaining', 'field', 'الكمية المتبقية', 'Quantity Remaining'],

    ['action.create_purchase_order', 'field', 'إنشاء أمر شراء', 'Create Purchase Order'],
    ['action.add_po_line', 'field', 'إضافة بند', 'Add Line'],
    ['action.submit', 'field', 'إرسال', 'Submit'],
    ['action.approve', 'field', 'اعتماد', 'Approve'],
    ['action.reject', 'field', 'رفض', 'Reject'],
    ['action.post_goods_receipt', 'field', 'تسجيل إذن استلام', 'Post Goods Receipt'],

    ['purchase_order_lifecycle.state.draft', 'field', 'مسودة', 'Draft'],
    ['purchase_order_lifecycle.state.submitted', 'field', 'بانتظار الاعتماد', 'Submitted'],
    ['purchase_order_lifecycle.state.approved', 'field', 'معتمد', 'Approved'],
    ['purchase_order_lifecycle.state.partially_received', 'field', 'مستلم جزئيًا', 'Partially Received'],
    ['purchase_order_lifecycle.state.received', 'field', 'مستلم بالكامل', 'Received'],
    ['purchase_order_lifecycle.state.closed', 'field', 'مغلق', 'Closed'],
    ['purchase_order_lifecycle.state.cancelled', 'field', 'ملغى', 'Cancelled'],

    ['panel.no_purchase_orders_yet', 'panel', 'لا توجد أوامر شراء بعد', 'No purchase orders yet'],
    ['panel.no_goods_receipts_yet', 'panel', 'لا توجد أذون استلام بعد', 'No goods receipts yet'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const values = this.rows.map(([code, category, ar, en]) => `('${code}', '${category}', '${ar.replace(/'/g, "''")}', '${en.replace(/'/g, "''")}')`).join(',\n       ');
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
