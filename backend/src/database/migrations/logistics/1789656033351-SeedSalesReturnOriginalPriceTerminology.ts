import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `logistics`-tagged (ADR-025). Historical Requirements Audit (2026-09-17),
 * A2.19 — the CTO-ratified pricing decision (2026-09-16) requires the
 * original sale price be preserved for "Eligibility / Provenance / Audit /
 * display". `SalesReturnLine.originalUnitPrice` was already returned by
 * `GET /sales-returns/:id` and `GET /sales-returns/eligible-purchases`
 * (`SalesReturnsService.getSalesReturnDetail`/`listEligiblePurchaseLines`)
 * but `SalesReturns.tsx` never rendered it next to the independently-
 * editable Return Price — a display gap, not a data gap. Same idempotent
 * (`ON CONFLICT`) shape as every other terminology seed.
 */
export class SeedSalesReturnOriginalPriceTerminology1789656033351 implements MigrationInterface {
  name = 'SeedSalesReturnOriginalPriceTerminology1789656033351';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
       VALUES ('field.original_unit_price', 'field', 'السعر الأصلي', 'Original Price')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = 'field.original_unit_price'`);
  }
}
