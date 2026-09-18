import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Terminology Registry expansion — CTO directive §3 ("Do not hardcode
 * translations inside screens"). The first UI pass (§4-6, 1755842500000)
 * covered workflow states/actions/roles/nav; this covers the panel
 * headings and common field labels the Fulfillment/Shipments/Returns/
 * Deposit/Reservation screens still had hardcoded in English.
 */
export class SeedUiPanelTerminology1755843100000 implements MigrationInterface {
  name = 'SeedUiPanelTerminology1755843100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['panel.stock_reservation', 'panel', 'حجز المخزون', 'Stock Reservation'],
      ['panel.deposit', 'panel', 'العربون', 'Deposit'],
      ['panel.released_for_fulfillment', 'panel', 'جاهز للتجهيز', 'Released for Fulfillment'],
      ['panel.released_for_fulfillment_body', 'panel', 'هذا الطلب جاهز للتجهيز. يمكن إنشاء ومتابعة أمر التجهيز والشحنة من شاشة', 'This order is ready for fulfillment. Create/track its Fulfillment Order and Shipment from the'],
      ['panel.create_fulfillment_order', 'panel', 'إنشاء أمر تجهيز', 'Create Fulfillment Order'],
      ['panel.pick_tasks', 'panel', 'مهام التجهيز', 'Pick Tasks'],
      ['panel.pack_tasks', 'panel', 'مهام التعبئة', 'Pack Tasks'],
      ['panel.create_shipment', 'panel', 'إنشاء شحنة', 'Create Shipment'],
      ['panel.no_open_pick_tasks', 'panel', 'لا توجد مهام تجهيز مفتوحة', 'No open pick tasks.'],
      ['panel.no_open_pack_tasks', 'panel', 'لا توجد مهام تعبئة مفتوحة', 'No open pack tasks.'],
      ['panel.no_shipments_yet', 'panel', 'لا توجد شحنات بعد', 'No shipments yet.'],
      ['panel.no_returns_yet', 'panel', 'لا توجد طلبات مرتجعات بعد', 'No return requests yet.'],
      ['panel.waiting_for_rep_deposit', 'panel', 'بانتظار قيام المندوب بإرسال العربون', 'Waiting for the Sales Rep to submit a deposit.'],
      ['panel.waiting_for_rep_reservation', 'panel', 'بانتظار قيام المندوب بحجز المخزون', 'Waiting for the Sales Rep to reserve stock.'],
      ['field.product', 'field', 'المنتج', 'Product'],
      ['field.quantity', 'field', 'الكمية', 'Qty'],
      ['field.method', 'field', 'طريقة الدفع', 'Method'],
      ['field.warehouse', 'field', 'المخزن', 'Warehouse'],
      ['field.driver', 'field', 'السائق', 'Driver'],
      ['field.reason', 'field', 'السبب', 'Reason'],
      ['field.waybill', 'field', 'رقم بوليصة الشحن', 'Waybill'],
      ['field.you', 'field', 'أنت', 'You'],
      ['field.name', 'field', 'الاسم', 'Name'],
      ['field.email', 'field', 'البريد الإلكتروني', 'Email'],
      ['field.phone', 'field', 'الهاتف', 'Phone'],
      ['field.code', 'field', 'الكود', 'Code'],
      ['field.fulfillment_order', 'field', 'أمر التجهيز', 'Fulfillment Order'],
      ['field.sales_order', 'field', 'أمر البيع', 'Sales Order'],
      ['field.assign_role', 'field', 'إسناد دور', 'Assign Role'],
      ['field.released_sales_order', 'field', 'أمر بيع جاهز', 'Released Sales Order'],
      ['field.ready_fulfillment_order', 'field', 'أمر تجهيز جاهز للشحن', 'Ready Fulfillment Order (pack task verified)'],
      ['action.reserve', 'action', 'حجز', 'Reserve'],
      ['action.assign', 'action', 'إسناد', 'Assign'],
      ['action.applies_to_every_line', 'action', 'ينطبق على كل بنود الطلب', 'applies to every line'],
      ['action.not_reserved', 'action', 'غير محجوز', 'not reserved'],
      ['action.register', 'action', 'تسجيل حساب جديد', 'Register'],
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
      'panel.stock_reservation', 'panel.deposit', 'panel.released_for_fulfillment', 'panel.released_for_fulfillment_body',
      'panel.create_fulfillment_order', 'panel.pick_tasks', 'panel.pack_tasks', 'panel.create_shipment',
      'panel.no_open_pick_tasks', 'panel.no_open_pack_tasks', 'panel.no_shipments_yet', 'panel.no_returns_yet',
      'panel.waiting_for_rep_deposit', 'panel.waiting_for_rep_reservation',
      'field.product', 'field.quantity', 'field.method', 'field.warehouse', 'field.driver', 'field.reason',
      'field.waybill', 'field.you', 'field.name', 'field.email', 'field.phone', 'field.code',
      'field.fulfillment_order', 'field.sales_order', 'field.assign_role', 'field.released_sales_order',
      'field.ready_fulfillment_order',
      'action.reserve', 'action.assign', 'action.applies_to_every_line', 'action.not_reserved', 'action.register',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
