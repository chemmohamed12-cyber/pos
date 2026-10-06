import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-061 Addendum 1 — terminology for the Manufacturing master-data screens (BOMs, Routings,
 * Work Centers, Assembly) and Work Order operation execution. New codes are namespaced `mfg.*`
 * (plus the five `nav.manufacturing_*` items) so this upsert can never overwrite a code owned by
 * another module.
 */
export class SeedManufacturingMasterDataTerminology1790000200000 implements MigrationInterface {
  name = 'SeedManufacturingMasterDataTerminology1790000200000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.manufacturing_boms', 'field', 'قوائم المواد (الوصفات)', 'Bills of Materials'],
    ['nav.manufacturing_routings', 'field', 'مسارات التشغيل', 'Routings'],
    ['nav.manufacturing_work_centers', 'field', 'مراكز العمل', 'Work Centers'],
    ['nav.manufacturing_assembly', 'field', 'التجميع', 'Assembly'],

    ['mfg.kpi.active_boms', 'field', 'قوائم المواد النشطة', 'Active BOMs'],
    ['mfg.kpi.routings', 'field', 'مسارات التشغيل', 'Routings'],
    ['mfg.kpi.work_centers', 'field', 'مراكز العمل', 'Work Centers'],

    ['mfg.status.active', 'field', 'نشط', 'Active'],
    ['mfg.status.inactive', 'field', 'غير نشط', 'Inactive'],

    ['mfg.field.code', 'field', 'الرمز', 'Code'],
    ['mfg.field.description', 'field', 'الوصف', 'Description'],
    ['mfg.field.unit', 'field', 'الوحدة', 'Unit'],
    ['mfg.field.component_count', 'field', 'عدد المكونات', 'Components'],
    ['mfg.field.sequence', 'field', 'التسلسل', 'Sequence'],
    ['mfg.field.operation', 'field', 'العملية', 'Operation'],
    ['mfg.field.operations', 'field', 'العمليات', 'Operations'],
    ['mfg.field.operations_count', 'field', 'عدد العمليات', 'Operations'],
    ['mfg.field.work_center', 'field', 'مركز العمل', 'Work Center'],
    ['mfg.field.routing_usage', 'field', 'عمليات مسار التشغيل', 'Routing operations'],
    ['mfg.field.quantity_to_assemble', 'field', 'الكمية المراد تجميعها', 'Quantity to assemble'],
    ['mfg.field.required_quantity', 'field', 'الكمية المطلوبة', 'Required quantity'],
    ['mfg.field.started_at', 'field', 'بدأت في', 'Started at'],
    ['mfg.field.completed_at', 'field', 'اكتملت في', 'Completed at'],

    ['mfg.action.new_bom', 'field', 'وصفة جديدة', 'New BOM'],
    ['mfg.action.new_routing', 'field', 'مسار تشغيل جديد', 'New Routing'],
    ['mfg.action.new_work_center', 'field', 'مركز عمل جديد', 'New Work Center'],
    ['mfg.action.add_operation', 'field', 'إضافة عملية', 'Add operation'],
    ['mfg.action.view', 'field', 'عرض', 'View'],
    ['mfg.action.edit', 'field', 'تعديل', 'Edit'],
    ['mfg.action.activate', 'field', 'تفعيل', 'Activate'],
    ['mfg.action.deactivate', 'field', 'تعطيل', 'Deactivate'],
    ['mfg.action.delete', 'field', 'حذف', 'Delete'],
    ['mfg.action.close', 'field', 'إغلاق', 'Close'],
    ['mfg.action.start_operation', 'field', 'بدء', 'Start'],
    ['mfg.action.complete_operation', 'field', 'إنهاء', 'Finish'],

    ['mfg.op.state.pending', 'field', 'بانتظار البدء', 'Pending'],
    ['mfg.op.state.in_progress', 'field', 'قيد التنفيذ', 'In Progress'],
    ['mfg.op.state.completed', 'field', 'مكتملة', 'Completed'],

    ['mfg.panel.no_boms', 'panel', 'لا توجد قوائم مواد بعد', 'No bills of materials yet'],
    ['mfg.panel.no_routings', 'panel', 'لا توجد مسارات تشغيل بعد', 'No routings yet'],
    ['mfg.panel.no_work_centers', 'panel', 'لا توجد مراكز عمل بعد', 'No work centers yet'],
    ['mfg.panel.no_operations', 'panel', 'لا توجد عمليات لهذا الأمر', 'This work order has no operations'],
    ['mfg.panel.bom_hint', 'panel', 'يلزم وجود قائمة مواد نشطة للمنتج قبل إنشاء أمر إنتاج أو تجميعه.', 'A product needs an active Bill of Materials before it can be manufactured or assembled.'],
    ['mfg.panel.routing_hint', 'panel', 'مسار التشغيل اختياري: عند وجوده ونشاطه تُنسخ عملياته إلى أمر الإنتاج عند الإصدار ويجب إنهاؤها قبل الإكمال.', 'A routing is optional: when present and active its operations are copied to the Work Order at release and must be finished before completion.'],
    ['mfg.panel.assembly_hint', 'panel', 'تجميع مباشر من خطوة واحدة اعتمادًا على قائمة المواد النشطة. للإنتاج متعدد المراحل والمتتبَّع استخدم أوامر الإنتاج.', 'Direct single-step build from the active Bill of Materials. For tracked, multi-step production use Work Orders.'],
    ['mfg.panel.assembly_no_boms', 'panel', 'لا توجد قوائم مواد نشطة للتجميع.', 'There are no active Bills of Materials to assemble from.'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const values = this.rows
      .map(([code, category, ar, en]) => `('${code}', '${category}', '${ar.replace(/'/g, "''")}', '${en.replace(/'/g, "''")}')`)
      .join(',\n       ');
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES
       ${values}
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const codes = this.rows.map(([code]) => `'${code}'`).join(', ');
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code IN (${codes})`);
  }
}
