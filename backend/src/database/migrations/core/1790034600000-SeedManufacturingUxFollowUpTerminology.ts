import { MigrationInterface, QueryRunner } from 'typeorm';

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
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(`INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en"`, [code, category, ar, en]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
