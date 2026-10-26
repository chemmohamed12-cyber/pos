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


/** Manufacturing UX redesign stage 5 (cost and exceptions) (2026-10-25) - AR/EN terminology. Upsert by code; `down` removes exactly these rows. */
export class SeedManufacturingUxStage5Terminology1790034500000 implements MigrationInterface {
  name = 'SeedManufacturingUxStage5Terminology1790034500000';

  private readonly rows: Array<[string, string, string, string]> = [
    ["nav.manufacturing_exceptions", 'field', "الاستثناءات والمراجعة", "Exceptions & review"],
    ["mfg2.oo.scrap.fix_link", 'field', "فتح سياسة المحاسبة لإصلاحه", "Open accounting policy to fix it"],
    ["mfg2.rc.title", 'field', "تسوية تكلفة الأمر", "Order cost reconciliation"],
    ["mfg2.rc.help", 'panel', "تُحسب من سجلات النظام فقط: رصيد العمل تحت التشغيل الفعلي مقابل ما رُحِّل فعلاً من قيود. الحدث المرفوض أو المعلّق لا يُحتسب مُرحَّلاً.", "Computed from system records only: the actual work-in-process balance against what was really posted to the books. A rejected or waiting event is never counted as posted."],
    ["mfg2.rc.physical", 'field', "رصيد WIP الفعلي للأمر", "Actual WIP balance of the order"],
    ["mfg2.rc.posted", 'field', "رصيد WIP حسب القيود المُرحَّلة", "WIP per posted journal entries"],
    ["mfg2.rc.unposted", 'field', "أثر أحداث لم تُرحَّل", "Effect of events not posted"],
    ["mfg2.rc.diff", 'field', "الفرق (الفعلي − المُرحَّل)", "Difference (actual − posted)"],
    ["mfg2.rc.verdict.ok", 'field', "الرصيد الفعلي يطابق القيود المُرحَّلة.", "The actual balance matches the posted entries."],
    ["mfg2.rc.verdict.unposted", 'panel', "الفرق يساوي أثر أحداث لم تُرحَّل بعد؛ راجع الأحداث المرفوضة أو المعلّقة أدناه وفي شاشة الاستثناءات.", "The difference equals the effect of events that are not posted yet; see the rejected or waiting events below and in the exceptions screen."],
    ["mfg2.rc.verdict.unexplained", 'panel', "فرق غير مفسَّر بأحداث غير مُرحَّلة؛ يلزم تحقيق.", "A difference not explained by unposted events; it needs investigation."],
    ["mfg2.rc.quantities", 'panel', "الكميات: المخطط {0} = المنتج {1} + الهالك {2} + المتبقي {3}.", "Quantities: planned {0} = produced {1} + scrapped {2} + remaining {3}."],
    ["mfg2.rc.movements", 'field', "حركات الأمر المحاسبية", "Accounting movements of the order"],
    ["mfg2.rc.empty", 'field', "لا توجد حركات محاسبية على الأمر بعد", "No accounting movements on the order yet"],
    ["mfg2.rc.col.movement", 'field', "الحركة", "Movement"],
    ["mfg2.rc.col.wip", 'field', "أثرها على WIP (المُرحَّل)", "Effect on WIP (posted)"],
    ["mfg2.rc.status.posted", 'field', "مُرحَّل", "Posted"],
    ["mfg2.rc.status.rejected", 'field', "مرفوض", "Rejected"],
    ["mfg2.rc.status.received", 'field', "بانتظار الترحيل", "Waiting to post"],
    ["mfg2.rc.status.pending", 'field', "معلّق", "Pending"],
    ["mfg2.rc.status.failed", 'field', "فشل", "Failed"],
    ["mfg2.rc.status.ignored", 'field', "متجاهَل", "Ignored"],
    ["mfg2.rc.ev.material_issued", 'field', "صرف مواد", "Material issue"],
    ["mfg2.rc.ev.material_returned", 'field', "إرجاع مواد", "Material return"],
    ["mfg2.rc.ev.finished_goods_received", 'field', "استلام ناتج نهائي", "Finished goods receipt"],
    ["mfg2.rc.ev.process_outputs_received", 'field', "استلام مخرجات متعددة", "Multi-output receipt"],
    ["mfg2.rc.ev.scrap_recognized", 'field', "هالك", "Scrap"],
    ["mfg2.rc.ev.recovery_received", 'field', "استرداد خامة", "Material recovery"],
    ["mfg2.rc.ev.created", 'field', "إنشاء الأمر", "Order created"],
    ["mfg2.rc.ev.released", 'field', "إصدار الأمر", "Order released"],
    ["mfg2.rc.ev.held", 'field', "إيقاف الأمر", "Order held"],
    ["mfg2.rc.ev.resumed", 'field', "استئناف الأمر", "Order resumed"],
    ["mfg2.rc.ev.completed", 'field', "إغلاق الأمر", "Order completed"],
    ["mfg2.rc.ev.cancelled", 'field', "إلغاء الأمر", "Order cancelled"],
    ["mfg2.rc.ev.scrap_recorded", 'field', "تسجيل هالك", "Scrap recorded"],
    ["mfg2.rc.ev.recovery_recorded", 'field', "تسجيل استرداد", "Recovery recorded"],
    ["mfg2.rc.ev.outcome_resolved", 'field', "حسم نتيجة جودة", "Quality outcome resolved"],
    ["mfg2.ex.intro", 'panel', "كل ما يحتاج قراراً في التصنيع من سجلات النظام: أحداث محاسبية لم تُرحَّل، أوامر موقوفة، وإمكانية تسجيل الهالك.", "Everything in manufacturing that needs a decision, from system records: accounting events that did not post, orders on hold, and whether scrap can be recorded."],
    ["mfg2.ex.scrap_blocked", 'field', "لا يمكن تسجيل الهالك حالياً:", "Scrap cannot be recorded right now:"],
    ["mfg2.ex.events.title", 'field', "أحداث محاسبية لم تُرحَّل", "Accounting events not posted"],
    ["mfg2.ex.events.help", 'panel', "الحركة المخزنية لهذه الأحداث تمت، لكن قيدها المحاسبي لم يُسجَّل. أصلح السبب ثم أعد المحاولة؛ لا يُعتبر شيء مُرحَّلاً قبل أن يظهر بحالة «مُرحَّل».", "The stock movement of these events happened, but their journal entry was NOT recorded. Fix the cause, then retry; nothing counts as posted until it shows \"Posted\"."],
    ["mfg2.ex.events.empty_title", 'field', "لا توجد أحداث غير مُرحَّلة", "No events outside \"posted\""],
    ["mfg2.ex.events.empty_desc", 'field', "كل الأحداث المحاسبية للتصنيع مُرحَّلة.", "Every manufacturing accounting event is posted."],
    ["mfg2.ex.no_events_permission", 'panel', "لا تملك صلاحية عرض الأحداث المحاسبية؛ اطلب من المحاسب مراجعتها.", "You do not have permission to view accounting events; ask accounting to review them."],
    ["mfg2.ex.redrive", 'field', "إعادة محاولة الترحيل", "Retry posting"],
    ["mfg2.ex.confirm_redrive", 'panel', "إعادة محاولة ترحيل هذا الحدث الآن؟ ستُعرض النتيجة الفعلية بعدها.", "Retry posting this event now? The real outcome will be shown afterwards."],
    ["mfg2.ex.redrive_result", 'field', "انتهت المحاولة. حالة الحدث الآن: {0}.", "The attempt finished. The event status is now: {0}."],
    ["mfg2.ex.hold.title", 'field', "أوامر موقوفة", "Orders on hold"],
    ["mfg2.ex.hold.empty", 'field', "لا توجد أوامر موقوفة", "No orders on hold"],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await seedTerminologyOwned(queryRunner, 'manufacturing', this.name, this.rows, 'update');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await unseedTerminologyOwned(queryRunner, 'manufacturing', this.name, this.rows);
  }
}
