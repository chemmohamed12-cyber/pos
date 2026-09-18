import { MigrationInterface, QueryRunner } from 'typeorm';

/** Operational Reports (V1 Release Candidate prep) — Reports screen terminology. */
export class SeedReportsTerminology1755846200000 implements MigrationInterface {
  name = 'SeedReportsTerminology1755846200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['nav.reports', 'nav', 'التقارير', 'Reports'],
      ['field.sales_by_period', 'field', 'المبيعات حسب الفترة', 'Sales by Period'],
      ['field.sales_by_customer', 'field', 'المبيعات حسب العميل', 'Sales by Customer'],
      ['field.sales_by_rep', 'field', 'المبيعات حسب المندوب', 'Sales by Sales Rep'],
      ['field.stock_report', 'field', 'تقرير المخزون', 'Stock Report'],
      ['field.warehouse_movements', 'field', 'حركات المخازن', 'Warehouse Movements'],
      ['field.delivery_report', 'field', 'تقرير التسليم', 'Delivery Report'],
      ['field.period', 'field', 'الفترة', 'Period'],
      ['field.group_by', 'field', 'التجميع حسب', 'Group By'],
      ['field.day', 'field', 'يوم', 'Day'],
      ['field.month', 'field', 'شهر', 'Month'],
      ['field.date_from', 'field', 'من تاريخ', 'From Date'],
      ['field.date_to', 'field', 'إلى تاريخ', 'To Date'],
      ['field.order_count', 'field', 'عدد الطلبات', 'Order Count'],
      ['field.deposit_status', 'field', 'حالة العربون', 'Deposit Status'],
      ['field.deposit_amount', 'field', 'مبلغ العربون', 'Deposit Amount'],
      ['field.outcome', 'field', 'نتيجة التسليم', 'Outcome'],
      ['field.collected_amount', 'field', 'المبلغ المحصل', 'Collected Amount'],
      ['field.all', 'field', 'الكل', 'All'],
      ['panel.no_report_data', 'panel', 'لا توجد بيانات', 'No data.'],
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
      'nav.reports', 'field.sales_by_period', 'field.sales_by_customer', 'field.sales_by_rep',
      'field.stock_report', 'field.warehouse_movements', 'field.delivery_report', 'field.period',
      'field.group_by', 'field.day', 'field.month', 'field.date_from', 'field.date_to',
      'field.order_count', 'field.deposit_status', 'field.deposit_amount', 'field.outcome',
      'field.collected_amount', 'field.all', 'panel.no_report_data',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
