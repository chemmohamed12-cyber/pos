import { MigrationInterface, QueryRunner } from 'typeorm';

// <terminology-ownership:begin> (identical in every seed migration; guarded by terminology-ownership.spec.ts - migrations must stay self-contained)
type TerminologyRow = readonly [code: string, category: string, ar: string, en: string];
type TerminologySeedMode = 'preserve' | 'update';

const TABLE = 'terminology_seed_ownership';

async function ensureTable(q: QueryRunner): Promise<void> {
  await q.query(
    `CREATE TABLE IF NOT EXISTS "${TABLE}" ("code" VARCHAR(128) PRIMARY KEY, "owner" VARCHAR(64) NOT NULL, "migration" VARCHAR(160) NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
}

async function seedTerminologyOwned(q: QueryRunner, owner: string, migration: string, rows: readonly TerminologyRow[], mode: TerminologySeedMode): Promise<void> {
  await ensureTable(q);
  for (const [code, category, ar, en] of rows) {
    const inserted: Array<{ code: string }> = await q.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING RETURNING "code"`,
      [code, category, ar, en],
    );
    if (inserted.length > 0) {
      await q.query(`INSERT INTO "${TABLE}" ("code", "owner", "migration") VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`, [code, owner, migration]);
      continue;
    }
    if (mode === 'update') {
      await q.query(
        `UPDATE "terminology_entries" SET "ar" = $2, "en" = $3 WHERE "code" = $1 AND EXISTS (SELECT 1 FROM "${TABLE}" o WHERE o."code" = $1 AND o."owner" = $4)`,
        [code, ar, en, owner],
      );
    }
  }
}

async function unseedTerminologyOwned(q: QueryRunner, owner: string, migration: string, rows: readonly TerminologyRow[]): Promise<void> {
  await ensureTable(q);
  const codes = rows.map(([code]) => code);
  await q.query(
    `DELETE FROM "terminology_entries" WHERE "code" IN (SELECT "code" FROM "${TABLE}" WHERE "owner" = $2 AND "migration" = $3 AND "code" = ANY($1))`,
    [codes, owner, migration],
  );
  await q.query(`DELETE FROM "${TABLE}" WHERE "owner" = $2 AND "migration" = $3 AND "code" = ANY($1)`, [codes, owner, migration]);
  // once the last ownership record is gone the bookkeeping table is removed too, so a full rollback leaves no schema residue (it is re-created on demand by the next seed)
  await q.query(`DO $$ BEGIN IF to_regclass('"${TABLE}"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "${TABLE}") THEN DROP TABLE "${TABLE}"; END IF; END $$`);
}
// <terminology-ownership:end>


/** Manufacturing UX redesign stage 2 (2026-10-25) - Quick Assembly, overview and navigation terminology (AR/EN). Upsert by code; `down` removes exactly these rows. */
export class SeedManufacturingUxStage2Terminology1790034000000 implements MigrationInterface {
  name = 'SeedManufacturingUxStage2Terminology1790034000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ["nav.manufacturing_quick_assembly", 'field', "التجميع السريع", "Quick assembly"],
    ["nav.manufacturing_routings_basic", 'field', "مسارات التصنيع الأساسية", "Basic routings"],
    ["nav_section.mfg_execution", 'field', "التنفيذ", "Execution"],
    ["nav_section.mfg_setup", 'field', "الإعداد", "Setup"],
    ["nav_section.mfg_review", 'field', "المراجعة", "Review"],
    ["mfg2.col.availability", 'field', "حالة التوفر", "Availability"],
    ["mfg2.col.available", 'field', "المتاح بالمخزن", "Available in warehouse"],
    ["mfg2.col.component", 'field', "المكوّن", "Component"],
    ["mfg2.col.consumed", 'field', "المستهلك فعلياً", "Consumed"],
    ["mfg2.col.order_no", 'field', "رقم الأمر", "Order no."],
    ["mfg2.col.path", 'field', "المسار", "Path"],
    ["mfg2.col.produced_planned", 'field', "المنتج / المخطط", "Produced / planned"],
    ["mfg2.col.product", 'field', "المنتج", "Product"],
    ["mfg2.col.required", 'field', "الكمية المطلوبة", "Required quantity"],
    ["mfg2.col.scrapped", 'field', "الهالك", "Scrap"],
    ["mfg2.col.shortage", 'field', "الكمية الناقصة", "Shortage"],
    ["mfg2.col.status", 'field', "الحالة", "Status"],
    ["mfg2.col.unit", 'field', "الوحدة", "Unit"],
    ["mfg2.common.action_failed", 'field', "تعذّر تنفيذ العملية.", "The action could not be completed."],
    ["mfg2.common.back", 'field', "رجوع", "Back"],
    ["mfg2.common.choose", 'field', "— اختر —", "— Choose —"],
    ["mfg2.common.load_failed", 'field', "تعذّر تحميل البيانات.", "Data could not be loaded."],
    ["mfg2.common.loading", 'field', "جارٍ التحميل…", "Loading…"],
    ["mfg2.common.next", 'field', "التالي", "Next"],
    ["mfg2.common.required", 'field', "مطلوب", "required"],
    ["mfg2.common.working", 'field', "جارٍ التنفيذ…", "Working…"],
    ["mfg2.overview.attention.draft", 'field', "أوامر مسودة", "Draft orders"],
    ["mfg2.overview.attention.in_progress", 'field', "أوامر قيد التنفيذ", "Orders in progress"],
    ["mfg2.overview.attention.on_hold", 'field', "أوامر معلّقة", "Orders on hold"],
    ["mfg2.overview.attention.rejected", 'field', "أحداث تصنيع مرفوضة محاسبياً", "Manufacturing events rejected by accounting"],
    ["mfg2.overview.attention.released", 'field', "أوامر مُصدرة لم تبدأ", "Released orders not started"],
    ["mfg2.overview.attention.title", 'field', "يحتاج إلى متابعتك", "Needs your attention"],
    ["mfg2.overview.ms.cta", 'field', "أوامر التصنيع متعدد المراحل", "Multi-stage work orders"],
    ["mfg2.overview.ms.ready_label", 'field', "تعريفات عمليات فعّالة", "Active process definitions"],
    ["mfg2.overview.ms.requires", 'panel', "يتطلب تعريف عملية فعّال، وإصدار الأمر وتشغيل المراحل وتسجيل المخرجات والهالك.", "Requires an active process definition; you release the order, run the stages and record outputs and scrap."],
    ["mfg2.overview.ms.title", 'field', "التصنيع متعدد المراحل", "Multi-stage manufacturing"],
    ["mfg2.overview.ms.when", 'panel', "للمنتجات التي تمر بعدة مراحل أو تنتج مخرجات متعددة أو نواتج وسيطة.", "For products that pass through several stages or yield multiple outputs or intermediates."],
    ["mfg2.overview.qa.cta", 'field', "ابدأ تجميعاً سريعاً", "Start a quick assembly"],
    ["mfg2.overview.qa.effect", 'panel', "يخصم المكوّنات ويُدخل المنتج التام في خطوة واحدة مع أمر تشغيل مكتمل.", "Deducts the components and receives the finished product in one step, with a completed work order."],
    ["mfg2.overview.qa.ready_label", 'field', "منتجات لها قائمة مواد فعّالة", "Products with an active BOM"],
    ["mfg2.overview.qa.title", 'field', "التجميع السريع", "Quick assembly"],
    ["mfg2.overview.qa.when", 'panel', "لمنتج بسيط له قائمة مواد فعّالة ويُجمَّع مباشرة دون مراحل.", "For a simple product with an active BOM that is assembled directly, without stages."],
    ["mfg2.overview.recent.empty_desc", 'field', "ستظهر هنا آخر الأوامر المكتملة.", "The latest completed orders will appear here."],
    ["mfg2.overview.recent.empty_title", 'field', "لا توجد أوامر مكتملة بعد", "No completed orders yet"],
    ["mfg2.overview.recent.title", 'field', "آخر الأوامر المكتملة", "Recently completed orders"],
    ["mfg2.overview.subtitle", 'panel', "اختر المسار المناسب: تجميع سريع لمنتج بسيط، أو تصنيع متعدد المراحل.", "Choose the right path: quick assembly for a simple product, or multi-stage manufacturing."],
    ["mfg2.overview.title", 'field', "التصنيع", "Manufacturing"],
    ["mfg2.path.basic", 'field', "أساسي", "Basic"],
    ["mfg2.path.process", 'field', "متعدد المراحل", "Multi-stage"],
    ["mfg2.qa.again", 'field', "تجميع آخر", "Assemble another"],
    ["mfg2.qa.avail_ok", 'field', "متوفر", "Available"],
    ["mfg2.qa.avail_short", 'field', "ناقص", "Short"],
    ["mfg2.qa.blocked_shortage", 'panel', "لا يمكن المتابعة: بعض المكوّنات غير كافية في هذا المخزن. وفّر الكميات الناقصة أو اختر مخزناً آخر.", "Cannot continue: some components are insufficient in this warehouse. Supply the shortage or choose another warehouse."],
    ["mfg2.qa.confirm", 'field', "تأكيد التجميع", "Confirm assembly"],
    ["mfg2.qa.confirm_failed_hint", 'field', "لم يتم تنفيذ أي حركة. يمكنك المحاولة مرة أخرى بأمان.", "Nothing was posted. You can safely try again."],
    ["mfg2.qa.consumption", 'field', "المكوّنات المستهلكة", "Components consumed"],
    ["mfg2.qa.cost_estimate", 'field', "التكلفة التقديرية للمواد", "Estimated material cost"],
    ["mfg2.qa.cost_note", 'panel', "التقدير للعلم فقط؛ التكلفة الفعلية تُحدَّد عند التأكيد بمتوسط التكلفة وقتها.", "The estimate is informational; the actual cost is fixed at confirmation using the moving average at that time."],
    ["mfg2.qa.cost_unknown", 'field', "غير متاحة", "Not available"],
    ["mfg2.qa.done_title", 'field', "تم التجميع", "Assembly completed"],
    ["mfg2.qa.effect_in", 'field', "يُضاف إلى المخزن", "Added to stock"],
    ["mfg2.qa.effect_out", 'field', "يُخصم من المخزن", "Deducted from stock"],
    ["mfg2.qa.intro", 'panel', "أربع خطوات قصيرة: اختيار المنتج، الكمية والمكوّنات، المراجعة، ثم النتيجة.", "Four short steps: choose the product, quantity and materials, review, then the result."],
    ["mfg2.qa.material_value", 'field', "قيمة المواد المستهلكة", "Value of materials consumed"],
    ["mfg2.qa.materials", 'field', "المكوّنات المطلوبة", "Required components"],
    ["mfg2.qa.no_products_desc", 'panel', "لا توجد منتجات مطابقة. أنشئ قائمة مواد فعّالة للمنتج أولاً.", "No matching products. Create an active BOM for the product first."],
    ["mfg2.qa.no_products_title", 'field', "لا توجد منتجات متاحة للتجميع", "No products available to assemble"],
    ["mfg2.qa.no_warnings", 'field', "لا توجد تحذيرات؛ تم ترحيل الأحداث المحاسبية.", "No warnings; the accounting events were posted."],
    ["mfg2.qa.open_events", 'field', "فتح الأحداث المالية", "Open financial events"],
    ["mfg2.qa.open_order", 'field', "فتح أمر التشغيل", "Open the work order"],
    ["mfg2.qa.output_value", 'field', "قيمة المنتج التام", "Finished goods value"],
    ["mfg2.qa.pick_product_first", 'field', "اختر منتجاً أولاً.", "Choose a product first."],
    ["mfg2.qa.pick_warehouse_first", 'field', "اختر المخزن.", "Choose the warehouse."],
    ["mfg2.qa.preview_note", 'panel', "هذه المعاينة للعلم ولا تحجز المخزون؛ يُعاد التحقق من الكميات عند التأكيد.", "This preview is informational and does not reserve stock; quantities are re-validated at confirmation."],
    ["mfg2.qa.produced", 'field', "المنتج / المخطط", "Produced / planned"],
    ["mfg2.qa.product", 'field', "المنتج", "Product"],
    ["mfg2.qa.product_hint", 'field', "تظهر المنتجات التي لها قائمة مواد فعّالة أولاً.", "Products with an active BOM are listed first."],
    ["mfg2.qa.product_search", 'field', "ابحث بالكود أو الاسم", "Search by code or name"],
    ["mfg2.qa.qty", 'field', "الكمية المراد تجميعها", "Quantity to assemble"],
    ["mfg2.qa.qty_hint", 'field', "عدد صحيح موجب", "A positive whole number"],
    ["mfg2.qa.qty_invalid", 'field', "أدخل عدداً صحيحاً موجباً.", "Enter a positive whole number."],
    ["mfg2.qa.qty_required", 'field', "الكمية مطلوبة.", "Quantity is required."],
    ["mfg2.qa.ready", 'field', "جاهز", "Ready"],
    ["mfg2.qa.reason_inactive_bom", 'field', "قائمة المواد غير فعّالة", "The BOM is not active"],
    ["mfg2.qa.reason_no_bom", 'field', "لا توجد قائمة مواد", "No BOM"],
    ["mfg2.qa.step1", 'field', "المنتج", "Product"],
    ["mfg2.qa.step2", 'field', "الكمية والمكوّنات", "Quantity & materials"],
    ["mfg2.qa.step3", 'field', "المراجعة", "Review"],
    ["mfg2.qa.step4", 'field', "النتيجة", "Result"],
    ["mfg2.qa.steps_label", 'field', "خطوات التجميع السريع", "Quick assembly steps"],
    ["mfg2.qa.unit_cost", 'field', "تكلفة الوحدة", "Unit cost"],
    ["mfg2.qa.value_unavailable", 'field', "غير متاحة", "Not available"],
    ["mfg2.qa.warehouse", 'field', "المخزن", "Warehouse"],
    ["mfg2.qa.warehouse_hint", 'panel', "المخازن الرئيسية فقط؛ مخازن أوامر التشغيل الوسيطة غير مدرجة.", "Main warehouses only; work-order WIP warehouses are not listed."],
    ["mfg2.qa.warnings", 'field', "تحذيرات", "Warnings"],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await seedTerminologyOwned(queryRunner, 'manufacturing', this.name, this.rows, 'update');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await unseedTerminologyOwned(queryRunner, 'manufacturing', this.name, this.rows);
  }
}
