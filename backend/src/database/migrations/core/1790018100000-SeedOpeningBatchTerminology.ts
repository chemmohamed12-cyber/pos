import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Inventory lifecycle, slice C4 (2026-10-19) - labels for the Opening Balance Batch permission nodes, its approval request types and the new opening-correction account
 * policy key. Data only - no schema change; every code is NEW and the insert never rewrites an existing label (ON CONFLICT DO NOTHING); `down` removes exactly these rows.
 */
export class SeedOpeningBatchTerminology1790018100000 implements MigrationInterface {
  name = 'SeedOpeningBatchTerminology1790018100000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['perm.inventory.opening_batch', 'perm', 'دفعة الأرصدة الافتتاحية', 'Opening balance batches'],
    ['perm.inventory.opening_batch.create', 'perm', 'إنشاء وتقديم وترحيل دفعة افتتاحية', 'Create, submit and post an opening batch'],
    ['perm.inventory.opening_batch.approve', 'perm', 'اعتماد دفعة افتتاحية', 'Approve an opening batch'],
    ['perm.inventory.opening_batch.correct', 'perm', 'عكس أو تصحيح دفعة افتتاحية', 'Reverse or correct an opening batch'],
    ['perm.inventory.opening_batch.override', 'perm', 'استثناء أهلية الصنف في دفعة افتتاحية', 'Override opening-batch eligibility'],
    ['action.inventory_opening_batch', 'action', 'اعتماد دفعة أرصدة افتتاحية', 'Opening balance batch approval'],
    ['action.inventory_opening_batch_reversal', 'action', 'اعتماد عكس دفعة افتتاحية', 'Opening batch reversal approval'],
    ['action.inventory_opening_batch_correction', 'action', 'اعتماد تصحيح دفعة افتتاحية', 'Opening batch correction approval'],
    ['policy.inventory_opening_correction_account_code.label', 'field', 'حساب تصحيح الأرصدة الافتتاحية', 'Opening balance correction account'],
    ['policy.inventory_opening_correction_account_code.help', 'panel', 'حساب حقوق ملكية يُرحَّل إليه تصحيح معتمد لرصيد افتتاحي بعد تحرك المخزون؛ لا يمر أبدًا على الأرباح والخسائر.', 'An equity account an approved correction of an opening balance posts against after stock has moved; never profit and loss.'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(`INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`, [code, category, ar, en]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
