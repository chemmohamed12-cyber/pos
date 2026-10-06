import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D8 (2026-10-05, CTO: keep the manual-JE + link-acquisition architecture, complete the UI workflow) — Fixed Assets screen:
 * lifecycle status (pending acquisition → active → disposed) and the "link acquisition journal" action. Same idempotent seed shape
 * as every other terminology migration.
 */
export class SeedFixedAssetAcquisitionLinkTerminology1789960000000 implements MigrationInterface {
  name = 'SeedFixedAssetAcquisitionLinkTerminology1789960000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['fixed_asset_lifecycle.state.pending_acquisition', 'state', 'بانتظار قيد الاقتناء', 'Pending acquisition'],
    ['fixed_asset_lifecycle.state.active', 'state', 'نشط', 'Active'],
    ['fixed_asset_lifecycle.state.disposed', 'state', 'مستبعد', 'Disposed'],
    ['action.link_acquisition', 'action', 'ربط قيد الاقتناء', 'Link acquisition journal'],
    ['field.acquisition_journal', 'field', 'قيد الاقتناء (مرحَّل)', 'Acquisition journal (posted)'],
    ['action.open_journals', 'action', 'فتح القيود اليومية', 'Open journal entries'],
    [
      'panel.link_acquisition_steps',
      'panel',
      '١) سجّل قيد الاقتناء يدويًا: مدين حساب تكلفة هذا الأصل بقيمة التكلفة تمامًا. ٢) رحّله. ٣) اختره هنا لربطه فيصبح الأصل نشطًا.',
      '1) Record the acquisition as a manual journal entry debiting this asset\'s cost account for exactly its cost. 2) Post it. 3) Pick it here to link it — the asset then becomes active.',
    ],
    [
      'panel.link_acquisition_none',
      'panel',
      'لا توجد قيود مرحَّلة مطابقة (مدين حساب التكلفة بقيمة التكلفة تمامًا وغير مرتبطة بأصل آخر). سجّل القيد ورحّله أولًا.',
      'No matching POSTED journal entry (a debit on the cost account for exactly the cost, not linked to another asset). Record and post it first.',
    ],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
