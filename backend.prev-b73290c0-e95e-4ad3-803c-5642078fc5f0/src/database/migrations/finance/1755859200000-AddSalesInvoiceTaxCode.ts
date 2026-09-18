import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F10-H3 (ADR-043 D1/D3, Blueprint §0 amendment). ONE additive, nullable
 * column on `sales_invoices` — the invoice-level (not per-line, V1 scope)
 * tax code reference. NULL = no explicit tax code set for this invoice
 * (falls back to `accounting.default_tax_code` config at draft-creation
 * time, per `TaxEngineService.calculateForInvoice`). No FK constraint —
 * `accounting_tax_codes` lives in a different domain module; same
 * cross-domain plain-uuid convention already used by `customerId`/
 * `salesOrderId` on this same table. `sales_invoice_lines` is
 * DELIBERATELY NOT touched (Blueprint §4 — line-level tax remains
 * DEFERRED). Backward compatible; every existing row keeps NULL.
 */
export class AddSalesInvoiceTaxCode1755859200000 implements MigrationInterface {
  name = 'AddSalesInvoiceTaxCode1755859200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_invoices" ADD COLUMN "taxCodeId" UUID`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_invoices" DROP COLUMN "taxCodeId"`);
  }
}
