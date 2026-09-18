import { MigrationInterface, QueryRunner } from 'typeorm';

/** Order Edit at Draft (full add/remove/change) + Deposit receipt evidence preview. */
export class SeedDraftEditAndDepositPreviewTerminology1755850200000 implements MigrationInterface {
  name = 'SeedDraftEditAndDepositPreviewTerminology1755850200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['panel.editing_draft_order', 'panel', 'تعديل الطلب — يمكن إضافة/حذف الأصناف وتعديل العربون قبل الإرسال للمراجعة', 'Editing the order — items and the deposit can be added, removed, or changed before submitting for review'],
      ['action.remove_item', 'action', 'حذف الصنف', 'Remove Item'],
      ['action.preview_receipt', 'action', 'معاينة الإيصال', 'Preview Receipt'],
      ['panel.deposit_evidence', 'panel', 'إيصال تحويل العربون', 'Deposit Transfer Receipt'],
      ['panel.no_deposit_evidence', 'panel', 'لم يتم إرفاق إيصال', 'No receipt attached'],
      ['dashboard.draft_orders', 'dashboard', 'مسودة', 'Draft'],
      ['dashboard.deposit_verification_orders', 'dashboard', 'اعتماد العربون', 'Deposit Verification'],
      ['field.order_count', 'field', 'عدد الطلبات', 'Orders'],
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
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [
      [
        'panel.editing_draft_order',
        'action.remove_item',
        'action.preview_receipt',
        'panel.deposit_evidence',
        'panel.no_deposit_evidence',
        'dashboard.draft_orders',
        'dashboard.deposit_verification_orders',
        'field.order_count',
      ],
    ]);
  }
}
