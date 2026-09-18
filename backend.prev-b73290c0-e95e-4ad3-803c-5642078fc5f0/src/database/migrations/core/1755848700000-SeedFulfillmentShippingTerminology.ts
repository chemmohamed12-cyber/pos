import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO directive ("شاشة التجهيز" rework — dashboard, receive-and-start,
 * multi-carrier shipping, COD/remittance) — every new Arabic/English
 * label this feature needs.
 */
export class SeedFulfillmentShippingTerminology1755848700000 implements MigrationInterface {
  name = 'SeedFulfillmentShippingTerminology1755848700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['dashboard.new_orders', 'dashboard', 'أوردرات جديدة', 'New Orders'],
      ['dashboard.under_preparation', 'dashboard', 'تحت التجهيز', 'Under Preparation'],
      ['dashboard.ready_for_shipping', 'dashboard', 'جاهزة للشحن', 'Ready for Shipping'],
      ['action.receive_and_start', 'action', 'استلام وبدء التجهيز', 'Receive & Start Preparation'],
      ['action.finish_packing', 'action', 'انتهاء التغليف ونقل إلى الشحن', 'Finish Packing & Move to Shipping'],
      ['action.back_to_dashboard', 'action', 'عودة للوحة التحكم', 'Back to dashboard'],
      ['field.new_order_detail', 'field', 'بيانات الأوردر', 'Order Details'],
      ['field.shipping_company', 'field', 'شركة الشحن', 'Shipping Company'],
      ['field.shipping_company_code', 'field', 'كود شركة الشحن', 'Shipping Company Code'],
      ['field.contact_phone', 'field', 'رقم التواصل', 'Contact Phone'],
      ['field.cod_amount', 'field', 'قيمة التحصيل (COD)', 'COD Amount'],
      ['field.collected_amount', 'field', 'المبلغ المحصل', 'Collected Amount'],
      ['field.remittance_status', 'field', 'حالة التوريد', 'Remittance Status'],
      ['field.treasury_account', 'field', 'الحساب المالى للتوريد', 'Treasury Account'],
      ['field.no_shipping_company', 'field', 'بدون شركة شحن (سائق داخلى)', 'No shipping company (in-house driver)'],
      ['remittance_status.pending', 'status', 'قيد التوريد', 'Pending'],
      ['remittance_status.remitted', 'status', 'تم التوريد', 'Remitted'],
      ['action.remit', 'action', 'توريد المبلغ للخزينة', 'Remit to Treasury'],
      ['panel.pending_remittances', 'panel', 'تحصيلات قيد التوريد', 'Collections Awaiting Remittance'],
      ['panel.no_pending_remittances', 'panel', 'لا توجد تحصيلات قيد التوريد', 'No collections awaiting remittance'],
      ['panel.shipping_companies', 'panel', 'شركات الشحن', 'Shipping Companies'],
      ['action.add_shipping_company', 'action', 'إضافة شركة شحن', 'Add Shipping Company'],
      ['panel.no_released_orders', 'panel', 'لا توجد أوردرات جديدة', 'No new orders'],
      ['panel.no_orders_in_bucket', 'panel', 'لا توجد أوردرات فى هذه الحالة', 'No orders in this status'],
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
      'dashboard.new_orders',
      'dashboard.under_preparation',
      'dashboard.ready_for_shipping',
      'action.receive_and_start',
      'action.finish_packing',
      'action.back_to_dashboard',
      'field.new_order_detail',
      'field.shipping_company',
      'field.shipping_company_code',
      'field.contact_phone',
      'field.cod_amount',
      'field.collected_amount',
      'field.remittance_status',
      'field.treasury_account',
      'field.no_shipping_company',
      'remittance_status.pending',
      'remittance_status.remitted',
      'action.remit',
      'panel.pending_remittances',
      'panel.no_pending_remittances',
      'panel.shipping_companies',
      'action.add_shipping_company',
      'panel.no_released_orders',
      'panel.no_orders_in_bucket',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
