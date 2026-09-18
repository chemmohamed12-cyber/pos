import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO instruction — Sales Order detail screen must show customer name/
 * phone, the responsible rep (`field.sales_rep` already exists), and
 * who created the order. `field.customer` and `field.phone` already
 * exist but are generic; these two are specific to this card.
 */
export class SeedSalesOrderDetailTerminology1755846900000 implements MigrationInterface {
  name = 'SeedSalesOrderDetailTerminology1755846900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.customer_phone', 'field', 'رقم تليفون العميل', 'Customer Phone'],
      ['field.created_by', 'field', 'أنشئ بواسطة', 'Created By'],
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
    const codes = ['field.customer_phone', 'field.created_by'];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
