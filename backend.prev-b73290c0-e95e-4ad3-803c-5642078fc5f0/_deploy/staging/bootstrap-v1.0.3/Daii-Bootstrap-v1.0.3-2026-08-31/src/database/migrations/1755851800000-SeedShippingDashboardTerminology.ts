import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Shipping Screen Redesign directive — terminology for the new
 * operational dashboard on Shipments.tsx (buckets, RSH-selection flow,
 * order tracking, collection recording). Reuses existing codes wherever
 * one already fits (field.governorate/address/customer_phone/
 * total_amount, field.collected_amount, action.remit, all the
 * shipment_lifecycle.state.* labels) — only genuinely new labels here.
 */
export class SeedShippingDashboardTerminology1755851800000 implements MigrationInterface {
  name = 'SeedShippingDashboardTerminology1755851800000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['panel.new_shipping_orders', 'panel', 'أوامر شحن جديدة', 'New Shipping Orders'],
    ['panel.bucket_in_progress', 'panel', 'جاري التسليم', 'In Progress'],
    ['panel.bucket_delivered', 'panel', 'تم التسليم', 'Delivered'],
    ['panel.bucket_returned', 'panel', 'مرتجع شحن', 'Shipping Return'],
    ['field.select_rsh', 'field', 'اختر أمر الشحن (RSH)', 'Select Shipping Order (RSH)'],
    ['action.assign_route', 'action', 'تخصيص المسار', 'Assign Route'],
    ['action.reassign_route', 'action', 'تغيير المسار', 'Change Route'],
    ['panel.order_tracking', 'panel', 'تتبع الطلب', 'Order Tracking'],
    ['field.current_custodian', 'field', 'الجهة الحالية', 'Current Custodian'],
    ['action.record_collection', 'action', 'تسجيل التحصيل', 'Record Collection'],
    ['action.initiate_shipping_return', 'action', 'تسجيل مرتجع شحن', 'Record Shipping Return'],
    ['field.route_reason', 'field', 'سبب التغيير', 'Reason for Change'],
    ['field.order_items', 'field', 'الأصناف', 'Items'],
    ['panel.select_rsh_to_view_details', 'panel', 'اختر أمر شحن (RSH) لعرض بيانات الطلب كاملة', 'Select an RSH to view full order details'],
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
