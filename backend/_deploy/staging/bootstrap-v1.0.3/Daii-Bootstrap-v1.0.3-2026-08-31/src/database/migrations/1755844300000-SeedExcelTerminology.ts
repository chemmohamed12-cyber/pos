import { MigrationInterface, QueryRunner } from 'typeorm';

/** Terminology for the Excel import/export UI (CTO finalization directive §3/§4). */
export class SeedExcelTerminology1755844300000 implements MigrationInterface {
  name = 'SeedExcelTerminology1755844300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['action.download_template', 'action', 'تحميل نموذج الاستيراد', 'Download Template'],
      ['action.export_excel', 'action', 'تصدير Excel', 'Export to Excel'],
      ['action.import_excel', 'action', 'استيراد من Excel', 'Import from Excel'],
      ['field.total_rows', 'field', 'إجمالي الصفوف', 'Total Rows'],
      ['field.succeeded_rows', 'field', 'صفوف ناجحة', 'Succeeded'],
      ['field.rejected_rows', 'field', 'صفوف مرفوضة', 'Rejected'],
      ['field.row', 'field', 'الصف', 'Row'],
      ['field.errors', 'field', 'الأخطاء', 'Errors'],
      ['panel.opening_stock_import', 'panel', 'استيراد الرصيد الافتتاحي', 'Opening Stock Import'],
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
      'action.download_template', 'action.export_excel', 'action.import_excel',
      'field.total_rows', 'field.succeeded_rows', 'field.rejected_rows', 'field.row', 'field.errors',
      'panel.opening_stock_import',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
