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


/** Manufacturing UX redesign follow-up package (setup health) (2026-10-25) - AR/EN terminology. Upsert by code; `down` removes exactly these rows. */
export class SeedManufacturingUxFollowUpTerminology1790034600000 implements MigrationInterface {
  name = 'SeedManufacturingUxFollowUpTerminology1790034600000';

  private readonly rows: Array<[string, string, string, string]> = [
    ["mfg2.su.title", 'field', "تهيئة التصنيع المحاسبية", "Manufacturing accounting setup"],
    ["mfg2.su.help", 'panel', "الإعدادات المحاسبية التي يحتاجها التصنيع. أي إعداد ناقص يُفشل الترحيل أو يمنع عمليات (كالهالك) قبل أن تبدأ.", "The accounting settings Manufacturing needs. A missing one makes posting fail or blocks operations (such as scrap) before they start."],
    ["mfg2.su.col.setting", 'field', "الإعداد", "Setting"],
    ["mfg2.su.col.detail", 'field', "التفاصيل", "Details"],
    ["mfg2.su.ok", 'field', "جاهز", "Ready"],
    ["mfg2.su.missing", 'field', "غير مضبوط", "Not set up"],
    ["mfg2.su.ok_detail", 'field', "مضبوط وصالح.", "Set up and valid."],
    ["mfg2.su.wip_account", 'field', "حساب الإنتاج تحت التشغيل (WIP)", "Work-in-process (WIP) control account"],
    ["mfg2.su.inventory_account", 'field', "حساب المخزون", "Inventory control account"],
    ["mfg2.su.scrap_loss_account", 'field', "حساب خسارة الهالك", "Scrap-loss account"],
    ["mfg2.su.receipt_reasons", 'field', "أسباب الاستلام اليدوي للمخزون", "Manual stock-receipt reasons"],
    ["mfg2.pe.qty.unit", 'field', "وحدة الكمية", "Quantity unit"],
    ["mfg2.pe.qty.kept", 'field', "المحفوظ حالياً دون تغيير:", "Currently kept unchanged:"],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await seedTerminologyOwned(queryRunner, 'manufacturing', this.name, this.rows, 'update');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await unseedTerminologyOwned(queryRunner, 'manufacturing', this.name, this.rows);
  }
}
