import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Warehouse & Inventory Control V1 closure pass — fixes a real Arabic-
 * first violation found during live UI verification: WarehouseOverview.tsx
 * hardcoded the English string "(at selling price)" inline inside an
 * otherwise-Arabic label. This gives it a proper Terminology Registry
 * code so it renders in the active UI language like every other label.
 */
export class SeedWarehouseOverviewFixTerminology1755847100000 implements MigrationInterface {
  name = 'SeedWarehouseOverviewFixTerminology1755847100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.at_selling_price', 'field', 'بسعر البيع', 'at selling price'],
      ['field.exception_type', 'field', 'نوع الاستثناء', 'Exception'],
      ['field.detail', 'field', 'التفاصيل', 'Detail'],
      ['action.review', 'action', 'مراجعة', 'Review'],
      ['field.transactions_awaiting_approval', 'field', 'حركة/حركات بانتظار الاعتماد', 'transaction(s) awaiting approval'],
      ['field.in_warehouse', 'field', 'في مخزن', 'in'],
      ['field.type', 'field', 'النوع', 'Type'],
      ['field.reference', 'field', 'المرجع', 'Reference'],
      ['field.notes', 'field', 'ملاحظات', 'Notes'],
      ['field.search_product_placeholder', 'field', 'ابحث برمز المنتج أو الاسم لإضافة بند…', 'Search SKU or product name to add a line…'],
      ['panel.no_lines_yet', 'panel', 'لا توجد بنود بعد — ابحث أعلاه لإضافة أول بند', 'No lines yet — search above to add the first one.'],
      ['error.product_already_on_transaction', 'error', 'هذا الصنف مضاف بالفعل لهذه الحركة — عدّل الكمية بدلاً من إضافته مرة أخرى', 'This product is already on this transaction — edit its quantity instead of adding it twice.'],
      ['error.add_at_least_one_line', 'error', 'أضف بندًا واحدًا على الأقل قبل الحفظ', 'Add at least one line before saving.'],
      ['error.lines_exceed_available', 'error', 'يوجد بند أو أكثر يطلب كمية أكبر من المتاح — عدّل الكمية قبل الحفظ', 'One or more lines request more than is available — fix the quantity before saving.'],
      ['error.quantity_exceeds_available', 'error', 'الكمية المطلوبة أكبر من المتاح', 'Requested quantity is greater than what\'s available.'],
      ['error.select_at_least_one_product', 'error', 'اختر صنفًا واحدًا على الأقل للجرد', 'Select at least one product to count.'],
      ['action.save_counts', 'action', 'حفظ الجرد', 'Save Counts'],
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
      'field.at_selling_price', 'field.exception_type', 'field.detail', 'action.review',
      'field.transactions_awaiting_approval', 'field.in_warehouse', 'field.type', 'field.reference', 'field.notes',
      'field.search_product_placeholder', 'panel.no_lines_yet',
      'error.product_already_on_transaction', 'error.add_at_least_one_line', 'error.lines_exceed_available', 'error.quantity_exceeds_available',
      'error.select_at_least_one_product', 'action.save_counts',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
