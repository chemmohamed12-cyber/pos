import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO request — split "شركات الشحن"/"سيارات الشركة" out of the Shipments
 * screen into their own "طرق الشحن" (Shipping Methods) sub-item under
 * Shipping, and give the Fulfillment/Production section its own Cover
 * screen like every other section. `nav_group.production`/`nav.fulfillment`
 * already exist and are reused as-is by the new Cover.
 */
export class SeedShippingMethodsAndFulfillmentCoverTerminology1755851400000 implements MigrationInterface {
  name = 'SeedShippingMethodsAndFulfillmentCoverTerminology1755851400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['nav.shipping_methods', 'nav', 'طرق الشحن', 'Shipping Methods'],
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
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [['nav.shipping_methods']]);
  }
}
