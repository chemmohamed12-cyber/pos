import { MigrationInterface, QueryRunner } from 'typeorm';

/** Operational Dashboard improvement (V1 Release Candidate prep) — dedicated label for the month-sales KPI card. */
export class SeedDashboardTerminology1755846400000 implements MigrationInterface {
  name = 'SeedDashboardTerminology1755846400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.month_sales_total', 'field', 'إجمالي مبيعات الشهر', "This Month's Sales"],
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
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [['field.month_sales_total']]);
  }
}
