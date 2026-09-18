import { MigrationInterface, QueryRunner } from 'typeorm';

/** Warehouse & Inventory Control UX/UI V1 (CTO directive §3) — collapsible sidebar section headers. */
export class SeedNavGroupTerminology1755846800000 implements MigrationInterface {
  name = 'SeedNavGroupTerminology1755846800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['nav_group.sales', 'nav', 'المبيعات', 'Sales'],
      ['nav_group.warehouses', 'nav', 'المخازن', 'Warehouses'],
      ['nav_group.production', 'nav', 'التجهيز', 'Production'],
      ['nav_group.shipping', 'nav', 'الشحن', 'Shipping'],
      ['nav_group.catalog', 'nav', 'الأصناف والأسعار', 'Catalog'],
      ['nav_group.administration', 'nav', 'الإدارة', 'Administration'],
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
    const codes = ['nav_group.sales', 'nav_group.warehouses', 'nav_group.production', 'nav_group.shipping', 'nav_group.catalog', 'nav_group.administration'];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
