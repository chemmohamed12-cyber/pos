import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `sales`-tagged (ADR-025). Frontend recovery/integration pass, Phase 2
 * gap audit (2026-09-17) — `POST/GET /sales/reps` (`sales.controller.ts`)
 * had zero frontend caller anywhere in the workspace and zero terminology
 * seeded for it. Distinct from the generic `sales_rep` RBAC role (already
 * assignable via `Admin.tsx`'s role selector): a `SalesRepProfile` row
 * (salesCode + territory) is real business data `SalesService.
 * createSalesRepProfile` ALSO auto-assigns the role for, so the two need
 * a dedicated UI, not just the generic role picker. Same idempotent
 * (`ON CONFLICT`) shape as every other terminology seed.
 */
export class SeedSalesRepProfileTerminology1789621007496 implements MigrationInterface {
  name = 'SeedSalesRepProfileTerminology1789621007496';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['field.sales_rep_profile', 'field', 'ملف مندوب المبيعات', 'Sales Rep Profile'],
    ['field.sales_code', 'field', 'كود المندوب', 'Sales Code'],
    ['field.territory', 'field', 'المنطقة', 'Territory'],
    ['action.view_sales_rep_profile', 'field', 'عرض ملف المندوب', 'View Sales Rep Profile'],
    ['action.create_sales_rep_profile', 'field', 'إنشاء ملف مندوب مبيعات', 'Create Sales Rep Profile'],
    ['panel.no_sales_rep_profile_yet', 'field', 'لا يوجد ملف مندوب مبيعات لهذا المستخدم', 'This user has no Sales Rep profile yet'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
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
  }
}
