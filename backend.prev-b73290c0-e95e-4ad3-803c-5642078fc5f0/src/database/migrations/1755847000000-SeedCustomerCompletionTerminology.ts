import { MigrationInterface, QueryRunner } from 'typeorm';

/** Customer & Sales Order UI Completion Review — terminology for the customer status/classification/assignment-type gaps closed. */
export class SeedCustomerCompletionTerminology1755847000000 implements MigrationInterface {
  name = 'SeedCustomerCompletionTerminology1755847000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.classification', 'field', 'التصنيف', 'Classification'],
      ['action.suspend', 'action', 'إيقاف مؤقت', 'Suspend'],
      ['action.reactivate', 'action', 'إعادة تفعيل', 'Reactivate'],
      ['assignment_type.primary', 'field', 'أساسي', 'Primary'],
      ['assignment_type.secondary', 'field', 'ثانوي', 'Secondary'],
      ['field.price_list_applied', 'field', 'قائمة الأسعار المطبقة', 'Price List Applied'],
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
    const codes = ['field.classification', 'action.suspend', 'action.reactivate', 'assignment_type.primary', 'assignment_type.secondary', 'field.price_list_applied'];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
