import { MigrationInterface, QueryRunner } from 'typeorm';

/** Post-Deposit-Approval Edit Control & Order Edit History (CTO directive §1). */
export class SeedOrderEditHistoryTerminology1755850400000 implements MigrationInterface {
  name = 'SeedOrderEditHistoryTerminology1755850400000';

  private readonly codes: Array<[string, string, string, string]> = [
    ['panel.edit_history', 'panel', 'سجل التعديلات', 'Edit History'],
    ['field.reason', 'field', 'السبب', 'Reason'],
    ['field.reason_required_released', 'field', 'سبب التعديل مطلوب للأوامر المعتمدة', 'A reason is required to edit an approved order'],
    ['field.old_value', 'field', 'القيمة القديمة', 'Old Value'],
    ['field.new_value', 'field', 'القيمة الجديدة', 'New Value'],
    ['field.edited_by', 'field', 'تم التعديل بواسطة', 'Edited By'],
    ['field.edited_at', 'field', 'التاريخ والوقت', 'Date & Time'],
    ['field.edited_field', 'field', 'الحقل', 'Field'],
    ['action.post_release_edit', 'action', 'تعديل بعد اعتماد العربون', 'Post-Deposit-Approval Edit'],
    ['panel.no_edit_history', 'panel', 'لا يوجد تعديلات مسجلة على هذا الأمر', 'No edits recorded for this order'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.codes) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "terminology_entries" WHERE code = ANY($1)`,
      [this.codes.map(([code]) => code)],
    );
  }
}
