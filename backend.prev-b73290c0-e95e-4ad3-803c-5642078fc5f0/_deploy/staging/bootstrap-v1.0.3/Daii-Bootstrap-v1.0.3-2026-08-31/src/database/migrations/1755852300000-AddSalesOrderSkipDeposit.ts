import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Post-v1.0.2 Hotfix 6 — "Create Sales Order Without a Deposit". Adds the
 * order-level flag `SalesOrdersService.transitionOrder` reads to decide
 * whether `manager_approve` should auto-advance straight to `released`
 * (via the new `manager_approve_no_deposit` transition,
 * `process-definition.ts`) instead of landing in `deposit_verification`.
 * Default `false` for every existing order — zero behavior change for
 * anything already in flight or completed.
 */
export class AddSalesOrderSkipDeposit1755852300000 implements MigrationInterface {
  name = 'AddSalesOrderSkipDeposit1755852300000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['field.skip_deposit', 'field', 'إنشاء بدون عربون', 'Create Without Deposit'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_orders" ADD COLUMN "skipDeposit" BOOLEAN NOT NULL DEFAULT false`);
    for (const [code, category, ar, en] of this.terminology) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.terminology.map(([code]) => code)]);
    await queryRunner.query(`ALTER TABLE "sales_orders" DROP COLUMN "skipDeposit"`);
  }
}
