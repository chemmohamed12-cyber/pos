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
}
// <terminology-ownership:end>


/** Manufacturing UX redesign stage 3 (BOM and units) (2026-10-25) - AR/EN terminology. Upsert by code; `down` removes exactly these rows. */
export class SeedManufacturingUxStage3BomTerminology1790034200000 implements MigrationInterface {
  name = 'SeedManufacturingUxStage3BomTerminology1790034200000';

  private readonly rows: Array<[string, string, string, string]> = [
    ["mfg2.bom.intro", 'panel', "قائمة المواد (الوصفة) تحدد ما يستهلكه الوحدة الواحدة من المنتج التام. تُحفظ الكميات بوحدات أساسية صحيحة ويمكنك كتابتها بعبوة أكبر وسيتحوّلها النظام بدقة.", "A bill of materials (recipe) says what one unit of the finished product consumes. Quantities are stored in whole base units; you may type them in a larger pack unit and the system converts them exactly."],
    ["mfg2.bom.base_unit", 'field', "وحدة أساسية", "base unit"],
    ["mfg2.bom.confirm_delete", 'field', "حذف قائمة المواد هذه نهائياً؟", "Delete this bill of materials permanently?"],
    ["mfg2.bom.search", 'field', "بحث بالكود أو الاسم", "Search by code or name"],
    ["mfg2.bom.new.product", 'field', "المنتج التام", "Finished product"],
    ["mfg2.bom.new.hint", 'field', "تظهر المنتجات التي ليس لها قائمة مواد بعد.", "Products that do not have a bill of materials yet."],
    ["mfg2.bom.new.cta", 'field', "قائمة مواد جديدة", "New bill of materials"],
    ["mfg2.bom.edit.title", 'field', "قائمة المواد", "Bill of materials"],
    ["mfg2.bom.edit.help", 'panel', "أضف المكوّنات والكمية اللازمة لوحدة واحدة من المنتج. السطر المعروض بجوار كل مكوّن يوضح ما سيُحفظ فعلياً.", "Add the components and the quantity needed for one unit of the product. The equivalent under each line shows what will really be stored."],
    ["mfg2.bom.line.component", 'field', "المكوّن", "Component"],
    ["mfg2.bom.line.qty", 'field', "الكمية لكل وحدة منتجة", "Quantity per unit produced"],
    ["mfg2.bom.line.qty_hint", 'field', "يقبل كسراً عشرياً؛ مثل 0.25", "A decimal is accepted, e.g. 0.25"],
    ["mfg2.bom.line.unit", 'field', "الوحدة", "Unit"],
    ["mfg2.bom.line.unit_none", 'panel', "لا توجد عبوات معرّفة لهذا المكوّن؛ عرّفها من «وحدات الصنف» أدناه.", "No pack units are defined for this component; define them under \"Product units\" below."],
    ["mfg2.bom.line.equiv", 'field', "المحفوظ فعلياً", "Stored as"],
    ["mfg2.bom.suggest", 'field', "أقرب كميتين صحيحتين:", "Nearest whole counts:"],
    ["mfg2.bom.err.component", 'field', "اختر المكوّن.", "Choose the component."],
    ["mfg2.bom.err.self", 'field', "لا يمكن أن يكون المنتج مكوّناً لنفسه.", "A product cannot be its own component."],
    ["mfg2.bom.err.duplicate", 'panel', "هذا المكوّن مكرر؛ اجمع كمياته في سطر واحد.", "This component is repeated; combine its quantities on one line."],
    ["mfg2.bom.err.qty_invalid", 'field', "أدخل كمية رقمية موجبة.", "Enter a positive numeric quantity."],
    ["mfg2.bom.err.qty_zero", 'field', "الكمية يجب أن تكون أكبر من صفر.", "The quantity must be greater than zero."],
    ["mfg2.bom.err.fraction", 'field', "الكمية لا تساوي عدداً صحيحاً من الوحدات الأساسية.", "The quantity is not a whole number of base units."],
    ["mfg2.bom.add_line", 'field', "إضافة مكوّن", "Add component"],
    ["mfg2.bom.save", 'field', "حفظ قائمة المواد", "Save bill of materials"],
    ["mfg2.bom.save_blocked", 'field', "عالج الملاحظات الظاهرة تحت الأسطر لتتمكن من الحفظ.", "Fix the notes shown under the lines to be able to save."],
    ["mfg2.bom.draft_note", 'panel', "الحفظ لا يغيّر حالة القائمة؛ تظهر في التجميع السريع عندما تكون «فعّالة».", "Saving does not change the list's status; it appears in Quick Assembly when it is \"Active\"."],
    ["mfg2.bom.status.active", 'field', "فعّالة", "Active"],
    ["mfg2.bom.status.inactive", 'field', "غير فعّالة", "Inactive"],
    ["mfg2.bom.status.active_help", 'panel', "قائمة فعّالة: يمكن استخدامها في التجميع السريع وأوامر التصنيع.", "An active list: it can be used by Quick Assembly and work orders."],
    ["mfg2.bom.status.inactive_help", 'panel', "قائمة غير فعّالة: لن يظهر المنتج في التجميع السريع قبل تفعيلها.", "An inactive list: the product will not appear in Quick Assembly until it is activated."],
    ["mfg2.bom.act.edit", 'field', "تعديل", "Edit"],
    ["mfg2.bom.act.activate", 'field', "تفعيل", "Activate"],
    ["mfg2.bom.act.deactivate", 'field', "إيقاف", "Deactivate"],
    ["mfg2.bom.act.delete", 'field', "حذف", "Delete"],
    ["mfg2.bom.notice.saved", 'field', "تم حفظ قائمة المواد. راجع حالتها أدناه.", "The bill of materials was saved. Check its status below."],
    ["mfg2.bom.notice.activated", 'field', "تم تفعيل قائمة المواد.", "The bill of materials is now active."],
    ["mfg2.bom.notice.deactivated", 'field', "تم إيقاف قائمة المواد.", "The bill of materials is now inactive."],
    ["mfg2.bom.notice.deleted", 'field', "تم حذف قائمة المواد.", "The bill of materials was deleted."],
    ["mfg2.bom.components", 'field', "مكوّنات القائمة", "Components"],
    ["mfg2.bom.col.sku", 'field', "الكود", "Code"],
    ["mfg2.bom.col.product", 'field', "المنتج التام", "Finished product"],
    ["mfg2.bom.col.components", 'field', "عدد المكوّنات", "Components"],
    ["mfg2.bom.col.qty_base", 'field', "الكمية (وحدات أساسية)", "Quantity (base units)"],
    ["mfg2.bom.stored_note", 'panel', "الكميات المعروضة هي المحفوظة فعلياً بالوحدات الأساسية للمكوّنات.", "The quantities shown are what is actually stored, in each component's base unit."],
    ["mfg2.bom.list.title", 'field', "قوائم المواد", "Bills of materials"],
    ["mfg2.bom.list.empty_title", 'field', "لا توجد قوائم مواد", "No bills of materials"],
    ["mfg2.bom.list.empty_desc", 'panel', "اختر منتجاً تاماً أعلاه وأنشئ قائمة مواده.", "Choose a finished product above and create its bill of materials."],
    ["mfg2.unit.title", 'field', "وحدات الصنف وتحويلات العبوات", "Product units & pack conversions"],
    ["mfg2.unit.help", 'panel', "وحدة الصنف هي وحدته الأساسية (عدد صحيح). كل تحويل يقول كم وحدة أساسية تحوي العبوة الأكبر؛ مثل كجم = 1000 جم.", "A product's unit is its whole-number base unit. A conversion says how many base units a larger pack holds, e.g. kg = 1000 g."],
    ["mfg2.unit.product", 'field', "الصنف", "Product"],
    ["mfg2.unit.table", 'field', "وحدات الصنف", "Product units"],
    ["mfg2.unit.empty", 'field', "لا توجد وحدات.", "No units."],
    ["mfg2.unit.base", 'field', "أساسية", "base"],
    ["mfg2.unit.equals", 'field', "تساوي", "Equals"],
    ["mfg2.unit.add_title", 'field', "إضافة تحويل عبوة", "Add a pack conversion"],
    ["mfg2.unit.code", 'field', "اسم الوحدة", "Unit name"],
    ["mfg2.unit.code_hint", 'field', "مثل: كجم، علبة، كرتونة", "e.g. kg, pack, carton"],
    ["mfg2.unit.factor", 'field', "عدد الوحدات الأساسية", "Number of base units"],
    ["mfg2.unit.factor_hint", 'field', "عدد صحيح 2 أو أكثر", "A whole number, 2 or more"],
    ["mfg2.unit.preview", 'field', "سيُحفظ", "Will be saved as"],
    ["mfg2.unit.add", 'field', "إضافة التحويل", "Add conversion"],
    ["mfg2.unit.err.code", 'field', "اكتب اسم الوحدة.", "Enter the unit name."],
    ["mfg2.unit.err.same_as_base", 'field', "هذه هي الوحدة الأساسية نفسها.", "This is the base unit itself."],
    ["mfg2.unit.err.exists", 'field', "هذه الوحدة معرّفة بالفعل لهذا الصنف.", "This unit is already defined for the product."],
    ["mfg2.unit.err.factor", 'field', "اكتب عدد الوحدات الأساسية.", "Enter the number of base units."],
    ["mfg2.unit.err.factor_int", 'field', "يجب أن يكون عدداً صحيحاً لا يقل عن 2.", "It must be a whole number, at least 2."],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await seedTerminologyOwned(queryRunner, 'manufacturing', this.name, this.rows, 'update');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await unseedTerminologyOwned(queryRunner, 'manufacturing', this.name, this.rows);
  }
}
