import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D4 (2026-10-05, CTO-approved Returns accounting policy) — the per-line FINANCIAL snapshot a completed Sales Return /
 * Shipment Return keeps: the original unit cost the stock re-entered at, the Revenue and tax parts credited (derived from
 * the ORIGINAL invoice value, never from the declared return price) and the invoice they reverse. Purely additive and
 * nullable — returns completed before D4, and returns of a sale that created no Revenue/AR, simply keep nulls.
 * `creditedGrossBase` on the header = the Customer Ledger credit(s) the document produced (AR reduction / customer credit).
 */
export class AddReturnFinancialSnapshot1789900000000 implements MigrationInterface {
  name = 'AddReturnFinancialSnapshot1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['sales_return_lines', 'shipment_return_lines']) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "unitCostBase" NUMERIC(18,4)`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "costTotalBase" NUMERIC(18,4)`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "creditNetBase" NUMERIC(14,2)`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "creditTaxBase" NUMERIC(14,2)`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "creditInvoiceId" UUID`);
    }
    for (const table of ['sales_returns', 'shipment_returns']) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "creditedGrossBase" NUMERIC(14,2)`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['sales_returns', 'shipment_returns']) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "creditedGrossBase"`);
    }
    for (const table of ['sales_return_lines', 'shipment_return_lines']) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "creditInvoiceId"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "creditTaxBase"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "creditNetBase"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "costTotalBase"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "unitCostBase"`);
    }
  }
}
