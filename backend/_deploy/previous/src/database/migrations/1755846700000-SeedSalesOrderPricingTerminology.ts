import { MigrationInterface, QueryRunner } from 'typeorm';

/** CTO instruction — per-rep order sequence + three-tier line pricing UI terminology. */
export class SeedSalesOrderPricingTerminology1755846700000 implements MigrationInterface {
  name = 'SeedSalesOrderPricingTerminology1755846700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.rep_sequence_number', 'field', 'رقم أوردر المندوب', 'Rep Order #'],
      ['field.sales_rep', 'field', 'المندوب', 'Sales Rep'],
      ['field.rep_price', 'field', 'سعر المندوب', 'Rep Price'],
      ['field.manager_price', 'field', 'سعر مدير المبيعات', 'Manager Price'],
      ['field.total_items', 'field', 'إجمالي الأصناف', 'Total Items'],
      ['field.total_discount', 'field', 'إجمالي الخصم', 'Total Discount'],
      ['field.total_price', 'field', 'إجمالي السعر', 'Total Price'],
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
      'field.rep_sequence_number', 'field.sales_rep', 'field.rep_price', 'field.manager_price',
      'field.total_items', 'field.total_discount', 'field.total_price',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
