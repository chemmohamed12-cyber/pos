import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Inventory lifecycle, slice C1 (2026-10-17) - labels for the valuation report, the cost KPI on the warehouse overview, the posting-status chip, the
 * "updated at" stamp, the periodic trial balance and the General Ledger source columns. Data only - no schema change; `down` removes exactly these rows.
 * Every code is NEW and the insert never rewrites an existing label (ON CONFLICT DO NOTHING).
 */
export class SeedInventoryC1Terminology1790017200000 implements MigrationInterface {
  name = 'SeedInventoryC1Terminology1790017200000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.valuation_report', 'nav', 'تقرير تقييم المخزون', 'Inventory valuation report'],
    ['field.at_cost', 'field', 'بالتكلفة', 'at cost'],
    ['field.val_cost_value', 'field', 'قيمة المخزون بالتكلفة', 'Inventory value at cost'],
    ['field.val_selling_value', 'field', 'القيمة بسعر البيع', 'Value at selling price'],
    ['field.val_as_of', 'field', 'حتى تاريخ', 'As of'],
    ['field.val_group_by', 'field', 'تجميع حسب', 'Group by'],
    ['value.val_group_warehouse', 'value', 'المخزن', 'Warehouse'],
    ['value.val_group_item', 'value', 'الصنف', 'Item'],
    ['field.val_warehouse', 'field', 'المخزن', 'Warehouse'],
    ['field.val_item', 'field', 'الصنف', 'Item'],
    ['field.val_quantity', 'field', 'الكمية', 'Quantity'],
    ['field.val_value', 'field', 'القيمة', 'Value'],
    ['field.val_avg_cost', 'field', 'متوسط التكلفة', 'Average cost'],
    ['panel.val_total', 'panel', 'الإجمالي', 'Total'],
    ['panel.val_no_rows', 'panel', 'لا توجد أرصدة مقيّمة في هذا التاريخ', 'No valued balances on this date'],
    ['panel.val_history_issue', 'panel', 'سجل التقييم لا يطابق الرصيد الجاري لبعض الأصناف — راجع المحاسبة', 'The valuation history does not match the running balance for some items — contact accounting'],
    ['panel.updated_at', 'panel', 'آخر تحديث', 'Updated'],
    ['panel.refresh_now', 'panel', 'تحديث الآن', 'Refresh now'],
    ['panel.refresh_failed', 'panel', 'تعذّر التحديث — تُعرض آخر بيانات ناجحة', 'Refresh failed — showing the last successful data'],
    ['panel.posting_current', 'panel', 'القيود محدّثة', 'Posting up to date'],
    ['panel.posting_pending', 'panel', 'قيود قيد الترحيل', 'Postings in progress'],
    ['panel.posting_attention', 'panel', 'قيود تحتاج مراجعة', 'Postings need attention'],
    ['panel.posting_counts', 'panel', 'قيد الانتظار / مرفوض', 'Pending / rejected'],
    ['panel.posting_last', 'panel', 'آخر ترحيل', 'Last posted'],
    ['field.gl_source', 'field', 'المصدر', 'Source'],
    ['field.gl_entry_state', 'field', 'حالة القيد', 'Entry state'],
    ['field.gl_event', 'field', 'الحدث المالي', 'Financial event'],
    ['panel.tb_mode_periodic', 'panel', 'عرض الفترة (افتتاحي / حركة / ختامي)', 'Periodic view (opening / movement / closing)'],
    ['panel.tb_mode_standard', 'panel', 'العرض المعتاد', 'Standard view'],
    ['field.tb_opening', 'field', 'الرصيد الافتتاحي', 'Opening balance'],
    ['field.tb_period_debit', 'field', 'مدين الفترة', 'Period debit'],
    ['field.tb_period_credit', 'field', 'دائن الفترة', 'Period credit'],
    ['field.tb_closing', 'field', 'الرصيد الختامي', 'Closing balance'],
    ['panel.tb_balanced_opening', 'panel', 'الافتتاحي متوازن', 'Opening balanced'],
    ['panel.tb_balanced_period', 'panel', 'حركة الفترة متوازنة', 'Period balanced'],
    ['panel.tb_balanced_closing', 'panel', 'الختامي متوازن', 'Closing balanced'],
    ['panel.recon_preview', 'panel', 'المطابقة الحالية بين التقييم ودفتر الأستاذ', 'Current valuation vs General Ledger'],
    ['field.recon_valuation', 'field', 'تقييم المخزون', 'Inventory valuation'],
    ['field.recon_gl', 'field', 'رصيد دفتر الأستاذ', 'General Ledger balance'],
    ['field.recon_drift', 'field', 'الفرق', 'Difference'],
    ['field.recon_explained', 'field', 'مفسَّر', 'Explained'],
    ['field.recon_unexplained', 'field', 'غير مفسَّر', 'Unexplained'],
    ['value.recon_class.matched', 'value', 'مطابق', 'Matched'],
    ['value.recon_class.explained', 'value', 'فرق مفسَّر بالكامل', 'Fully explained difference'],
    ['value.recon_class.unexplained', 'value', 'فرق غير مفسَّر', 'Unexplained difference'],
    ['value.recon_cat.rounding', 'value', 'فروق تقريب', 'Rounding'],
    ['value.recon_cat.unposted_value', 'value', 'قيمة لم تُرحَّل بعد', 'Value not yet posted'],
    ['value.recon_cat.f07_without_valuation_effect', 'value', 'قيود تسوية مالية بدون أثر على التقييم', 'Financial adjustments without valuation effect'],
    ['value.recon_cat.manual_or_opening_journals', 'value', 'قيود يدوية أو افتتاحية', 'Manual or opening journals'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO NOTHING`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
