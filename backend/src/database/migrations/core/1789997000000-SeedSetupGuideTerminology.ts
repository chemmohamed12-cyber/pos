import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NAV-01 / NAV-09 (2026-10-06) — Setup & Process Guidance page: title, intro, setup-stage names, process-flow names and the few step labels that
 * have no existing nav.* code. Idempotent seed; every text <= 255 characters.
 */
export class SeedSetupGuideTerminology1789997000000 implements MigrationInterface {
  name = 'SeedSetupGuideTerminology1789997000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.guide', 'nav', 'دليل الإعداد والعمليات', 'Setup & process guide'],
    ['panel.guide_intro', 'panel', 'ترتيب إعداد الشركة المعتاد ومسارات العمل الرئيسية. كل خطوة تفتح الشاشة الموجودة لها، وعلامة «تم/لم يتم» تُقرأ من بيانات الشركة وفق صلاحياتك. هذه الصفحة إرشادية فقط.', 'The usual Company setup order and the main process chains. Each step opens its existing screen; the done / to-do hint is read from Company data under your permissions. Guidance only.'],
    ['panel.guide_setup_title', 'panel', 'ترتيب الإعداد', 'Setup order'],
    ['panel.guide_flows_title', 'panel', 'مسارات العمل الرئيسية', 'Main process flows'],
    ['value.guide_status.done', 'value', 'تم', 'Done'],
    ['value.guide_status.todo', 'value', 'لم يتم', 'To do'],
    ['guide.stage.foundation', 'panel', 'الأساس (الهيكل والمخازن والمستخدمون)', 'Foundation (organization, warehouses, users)'],
    ['guide.stage.accounting', 'panel', 'المحاسبة', 'Accounting'],
    ['guide.stage.treasury', 'panel', 'الخزينة', 'Treasury'],
    ['guide.stage.master_data', 'panel', 'البيانات الأساسية', 'Master data'],
    ['guide.stage.operations', 'panel', 'العمليات', 'Operations'],
    ['guide.stage.control', 'panel', 'الرقابة', 'Control'],
    ['guide.stage.reports', 'panel', 'التقارير', 'Reports'],
    ['guide.flow.procurement', 'panel', 'المشتريات: مورد ← طلب شراء ← طلب عروض ← ترسية ← أمر شراء ← استلام ← فاتورة مورد ← سداد', 'Procurement: supplier → PR → RFQ → award → PO → receipt → supplier invoice → payment'],
    ['guide.flow.sales', 'panel', 'المبيعات: عميل ← صنف/سعر ← أمر بيع ← تجهيز ← شحن ← فاتورة ← تحصيل', 'Sales: customer → product/price → sales order → fulfilment → shipment → invoice → payment'],
    ['guide.flow.inventory', 'panel', 'المخزون: صنف ← مخزن ← رصيد ← حركة ← جرد ← تسوية محاسبية', 'Inventory: product → warehouse → stock → movement → count → reconciliation'],
    ['guide.step.award', 'panel', 'الترسية', 'Award'],
    ['guide.step.goods_receipt', 'panel', 'استلام البضاعة', 'Goods receipt'],
    ['guide.step.supplier_payment', 'panel', 'سداد المورد', 'Supplier payment'],
    ['guide.step.product_price', 'panel', 'الصنف والسعر', 'Product & price'],
    ['guide.step.stock', 'panel', 'رصيد المخزون', 'Stock on hand'],
    ['guide.step.reconciliation', 'panel', 'التسوية المحاسبية للمخزون', 'Inventory reconciliation'],
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
