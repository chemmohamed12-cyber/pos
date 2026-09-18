import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO directive ("FINAL SALES ORDER / CUSTOMER REVIEW") — terminology for
 * the warehouse-scoped stock-availability check and the newly-visible
 * Price List price on the Sales Order create/detail screens.
 */
export class SeedSalesOrderStockPricingTerminology1755847400000 implements MigrationInterface {
  name = 'SeedSalesOrderStockPricingTerminology1755847400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.available_stock', 'field', 'الرصيد المتاح', 'Available Stock'],
      ['field.price_list_price', 'field', 'سعر قائمة الأسعار', 'Price List Price'],
      [
        'validation.insufficient_stock',
        'validation',
        'الكمية المطلوبة أكبر من الرصيد المتاح. المطلوب: {requested} — المتاح: {available} — العجز: {shortfall}',
        'Requested quantity exceeds available stock. Requested: {requested} — Available: {available} — Shortfall: {shortfall}',
      ],
      ['field.select_warehouse', 'field', 'اختر المخزن', 'Select warehouse'],
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
    const codes = ['field.available_stock', 'field.price_list_price', 'validation.insufficient_stock', 'field.select_warehouse'];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
