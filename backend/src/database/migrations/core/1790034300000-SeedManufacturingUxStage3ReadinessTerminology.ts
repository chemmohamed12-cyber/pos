import { MigrationInterface, QueryRunner } from 'typeorm';

/** Manufacturing UX redesign stage 3 (readiness) (2026-10-25) - AR/EN terminology. Upsert by code; `down` removes exactly these rows. */
export class SeedManufacturingUxStage3ReadinessTerminology1790034300000 implements MigrationInterface {
  name = 'SeedManufacturingUxStage3ReadinessTerminology1790034300000';

  private readonly rows: Array<[string, string, string, string]> = [
    ["nav.manufacturing_readiness", 'field', "جاهزية المنتجات", "Product readiness"],
    ["mfg2.rd.intro", 'panel', "يوضح لكل منتج: هل هو جاهز للتجميع السريع (قائمة مواد فعّالة) أو للتصنيع متعدد المراحل (تعريف عملية فعّال)، وما الناقص وأين تُكمله.", "Shows for each product whether it is ready for Quick Assembly (an active bill of materials) or Multi-Stage manufacturing (an active process definition), what is missing and where to complete it."],
    ["mfg2.rd.kpi.qa", 'field', "منتجات جاهزة للتجميع السريع", "Products ready for Quick Assembly"],
    ["mfg2.rd.kpi.ms", 'field', "منتجات جاهزة للتصنيع متعدد المراحل", "Products ready for Multi-Stage"],
    ["mfg2.rd.search", 'field', "بحث بالكود أو الاسم", "Search by code or name"],
    ["mfg2.rd.scope", 'field', "المنتجات المعروضة", "Products shown"],
    ["mfg2.rd.scope_hint", 'field', "الافتراضي: المنتجات التي بدأ إعدادها فقط.", "Default: only products whose setup has started."],
    ["mfg2.rd.scope.configured", 'field', "التي لها قائمة مواد أو تعريف عملية", "With a bill of materials or process definition"],
    ["mfg2.rd.scope.all", 'field', "كل المنتجات", "All products"],
    ["mfg2.rd.table", 'field', "جاهزية المنتجات للتصنيع", "Product manufacturing readiness"],
    ["mfg2.rd.col.qa", 'field', "التجميع السريع", "Quick Assembly"],
    ["mfg2.rd.col.ms", 'field', "التصنيع متعدد المراحل", "Multi-Stage"],
    ["mfg2.rd.ready", 'field', "جاهز", "Ready"],
    ["mfg2.rd.not_ready", 'field', "غير جاهز", "Not ready"],
    ["mfg2.rd.fix", 'field', "استكمال الإعداد", "Complete setup"],
    ["mfg2.rd.qa.missing", 'field', "لا توجد قائمة مواد.", "No bill of materials."],
    ["mfg2.rd.qa.inactive", 'field', "قائمة المواد غير فعّالة.", "The bill of materials is inactive."],
    ["mfg2.rd.ms.missing", 'field', "لا يوجد تعريف عملية.", "No process definition."],
    ["mfg2.rd.ms.draft", 'field', "يوجد مسودة غير مفعّلة فقط.", "Only an unactivated draft exists."],
    ["mfg2.rd.empty_title", 'field', "لا توجد منتجات مطابقة", "No matching products"],
    ["mfg2.rd.empty_desc", 'field', "غيّر البحث أو اعرض كل المنتجات.", "Change the search or show all products."],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(`INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en"`, [code, category, ar, en]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
