import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NAV-03 (2026-10-06) — "Pending work" screen + Dashboard widget: one place that counts everything waiting for a decision across the Approval Engine
 * and the Process-Engine approvals that live inside their own screens. Idempotent seed; every text <= 255 characters.
 */
export class SeedPendingWorkTerminology1789996000000 implements MigrationInterface {
  name = 'SeedPendingWorkTerminology1789996000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.pending_work', 'nav', 'بانتظار القرار', 'Pending work'],
    ['panel.pending_work_intro', 'panel', 'كل ما ينتظر اعتمادًا أو قرارًا في النظام في مكان واحد. اضغط «فتح» للانتقال إلى الشاشة التي يُتخذ فيها القرار.', 'Everything waiting for an approval or a decision, in one place. Press Open to go to the screen where the decision is taken.'],
    ['panel.pending_work_two_engines', 'panel', 'يعرض النظام نوعين من الاعتماد: محرك الموافقات (صانع/مراجع) واعتمادات مراحل العمليات داخل شاشاتها. هذه الصفحة تعدّهما فقط ولا تدمجهما، ولا تظهر إلا المصادر المسموح لك بفتحها.', 'The system has two kinds of approval: the Approval Engine (maker/checker) and process-stage approvals inside their own screens. This page only counts them and shows only the sources you may open.'],
    ['panel.pending_work_none', 'panel', 'لا يوجد ما ينتظر قرارًا الآن.', 'Nothing is waiting for a decision right now.'],
    ['field.pending_count', 'field', 'العدد', 'Waiting'],
    ['field.oldest_waiting', 'field', 'أقدم عنصر', 'Oldest'],
    ['pending_work.source.approval_engine', 'panel', 'طلبات محرك الموافقات', 'Approval Engine requests'],
    ['pending_work.source.purchase_request', 'panel', 'طلبات الشراء بانتظار الاعتماد', 'Purchase requests awaiting approval'],
    ['pending_work.source.purchase_order', 'panel', 'أوامر الشراء بانتظار الاعتماد', 'Purchase orders awaiting approval'],
    ['pending_work.source.warehouse_transaction', 'panel', 'حركات المخزون بانتظار الاعتماد', 'Warehouse transactions awaiting approval'],
    ['pending_work.source.sales_order_supervisor', 'panel', 'أوامر البيع — مراجعة المشرف', 'Sales orders — supervisor review'],
    ['pending_work.source.sales_order_manager', 'panel', 'أوامر البيع — اعتماد المدير', 'Sales orders — manager approval'],
    ['pending_work.source.sales_order_deposit', 'panel', 'أوامر البيع — التحقق من العربون', 'Sales orders — deposit verification'],
    ['pending_work.source.return_request', 'panel', 'طلبات المرتجعات بانتظار التفويض', 'Return requests awaiting authorization'],
    ['pending_work.source.item_request', 'panel', 'طلبات أصناف جديدة بانتظار القرار', 'New item requests awaiting a decision'],
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
