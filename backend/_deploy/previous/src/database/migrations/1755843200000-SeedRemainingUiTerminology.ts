import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Terminology Registry expansion, part 3 — remaining codes found while
 * sweeping every screen for hardcoded English (CTO directive §3).
 */
export class SeedRemainingUiTerminology1755843200000 implements MigrationInterface {
  name = 'SeedRemainingUiTerminology1755843200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['panel.no_customers_yet', 'panel', 'لا يوجد عملاء بعد', 'No customers yet.'],
      ['panel.no_sales_orders_yet', 'panel', 'لا توجد أوامر بيع بعد', 'No sales orders yet.'],
      ['panel.no_action_for_role', 'panel', 'لا يوجد إجراء متاح لدورك في هذه المرحلة', 'No action available at this stage for your role.'],
      ['panel.awaiting_fulfillment', 'panel', 'معتمد بانتظار التجهيز', 'Released, awaiting fulfillment'],
      ['field.unit_price', 'field', 'سعر الوحدة', 'Unit Price'],
      ['field.line_total', 'field', 'إجمالي البند', 'Line Total'],
      ['field.lines', 'field', 'بنود الطلب', 'Lines'],
      ['action.add_line', 'action', 'إضافة بند', 'Line'],
      ['action.submit_deposit', 'action', 'إرسال العربون', 'Submit Deposit'],
      ['action.approve_deposit', 'action', 'اعتماد العربون', 'Approve Deposit'],
      ['method.bank_transfer', 'method', 'تحويل بنكي', 'Bank Transfer'],
      ['method.cash', 'method', 'نقدًا', 'Cash'],
      ['method.card', 'method', 'بطاقة', 'Card'],
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
      'panel.no_customers_yet', 'panel.no_sales_orders_yet', 'panel.no_action_for_role', 'panel.awaiting_fulfillment',
      'field.unit_price', 'field.line_total', 'field.lines', 'action.add_line', 'action.submit_deposit',
      'action.approve_deposit', 'method.bank_transfer', 'method.cash', 'method.card',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
