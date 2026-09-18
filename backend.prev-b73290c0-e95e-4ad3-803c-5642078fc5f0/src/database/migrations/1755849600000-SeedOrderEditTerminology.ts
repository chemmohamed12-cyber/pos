import { MigrationInterface, QueryRunner } from 'typeorm';

/** Order Edit During Review (CTO directive §1). */
export class SeedOrderEditTerminology1755849600000 implements MigrationInterface {
  name = 'SeedOrderEditTerminology1755849600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['action.edit', 'action', 'تعديل', 'Edit'],
      ['panel.editing_order', 'panel', 'وضع التعديل — يمكن تعديل الكمية والسعر لكل بند', 'Edit mode — quantity and price can be changed per line'],
      ['field.preliminary_hold', 'field', 'حجز مبدئي', 'Preliminary Hold'],
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
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [['action.edit', 'panel.editing_order', 'field.preliminary_hold']]);
  }
}
