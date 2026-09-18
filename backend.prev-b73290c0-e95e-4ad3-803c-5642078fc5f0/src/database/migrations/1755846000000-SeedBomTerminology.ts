import { MigrationInterface, QueryRunner } from 'typeorm';

/** Gap G-2 (EXCEL_BUSINESS_MAPPING_PACKAGE.md) — BOM/Assembly UI terminology. */
export class SeedBomTerminology1755846000000 implements MigrationInterface {
  name = 'SeedBomTerminology1755846000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['nav.bom', 'nav', 'قوائم التجميع', 'Bills of Materials'],
      ['field.finished_product', 'field', 'المنتج التام', 'Finished Product'],
      ['field.component', 'field', 'المكون', 'Component'],
      ['field.quantity_per_unit', 'field', 'الكمية لكل وحدة', 'Qty per Unit'],
      ['field.assembly_reference', 'field', 'مرجع التجميع', 'Assembly Reference'],
      ['panel.no_boms_yet', 'panel', 'لا توجد قوائم تجميع بعد', 'No Bills of Materials yet.'],
      ['panel.no_bom_components_yet', 'panel', 'أضف مكونًا واحدًا على الأقل', 'Add at least one component.'],
      ['action.add_component', 'action', 'إضافة مكون', 'Add Component'],
      ['action.define_bom', 'action', 'حفظ قائمة التجميع', 'Save Bill of Materials'],
      ['action.assemble', 'action', 'تجميع الإنتاج', 'Assemble'],
      ['panel.assembly_success', 'panel', 'تم التجميع بنجاح', 'Assembly completed'],
      ['movement_type.assembly_consumption', 'movement_type', 'استهلاك تجميع', 'Assembly Consumption'],
      ['movement_type.assembly_output', 'movement_type', 'ناتج تجميع', 'Assembly Output'],
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
      'nav.bom', 'field.finished_product', 'field.component', 'field.quantity_per_unit',
      'field.assembly_reference', 'panel.no_boms_yet', 'panel.no_bom_components_yet',
      'action.add_component', 'action.define_bom', 'action.assemble', 'panel.assembly_success',
      'movement_type.assembly_consumption', 'movement_type.assembly_output',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
