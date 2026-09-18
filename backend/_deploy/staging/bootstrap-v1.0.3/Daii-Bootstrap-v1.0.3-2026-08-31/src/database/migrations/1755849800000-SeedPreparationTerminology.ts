import { MigrationInterface, QueryRunner } from 'typeorm';

/** CTO directive ("PRIORITY: ITEM PREPARATION") — per-item Preparation screen labels. */
export class SeedPreparationTerminology1755849800000 implements MigrationInterface {
  name = 'SeedPreparationTerminology1755849800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['panel.preparation_items', 'panel', 'تجهيز الأصناف', 'Item Preparation'],
      ['field.requested_quantity', 'field', 'الكمية المطلوبة', 'Requested Quantity'],
      ['field.prepared_quantity', 'field', 'الكمية المجهزة', 'Prepared Quantity'],
      ['field.remaining_quantity', 'field', 'المتبقي', 'Remaining'],
      ['action.mark_done', 'action', 'تم', 'Done'],
      ['action.mark_all_done', 'action', 'تم للجميع', 'Mark All Done'],
      ['prep_item_status.pending', 'status', 'قيد التجهيز', 'Pending'],
      ['prep_item_status.prepared', 'status', 'تم التجهيز', 'Prepared'],
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
    const codes = [
      'panel.preparation_items',
      'field.requested_quantity',
      'field.prepared_quantity',
      'field.remaining_quantity',
      'action.mark_done',
      'action.mark_all_done',
      'prep_item_status.pending',
      'prep_item_status.prepared',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
