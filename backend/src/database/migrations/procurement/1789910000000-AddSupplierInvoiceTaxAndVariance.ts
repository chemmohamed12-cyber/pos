import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D5 (2026-10-05, CTO-approved PPV + Input VAT policy). A Supplier Invoice now carries:
 *  - `taxAmount` — the EXPLICIT VAT amount stated by the supplier's document (the invoice `totalAmount` stays NET / tax-exclusive;
 *    gross = net + tax). Defaults to 0 for every existing row (no behaviour change for them).
 *  - `receiptValueBase` — what the Goods Receipt(s) credited to GRNI for the invoiced quantities (qty × PO unit cost);
 *  - `ppvBase` — the signed Purchase Price Variance = invoice net − receiptValueBase (positive = invoice higher).
 * Both snapshots are nullable: invoices drafted before D5 keep NULL (their journals keep the legacy shape).
 */
export class AddSupplierInvoiceTaxAndVariance1789910000000 implements MigrationInterface {
  name = 'AddSupplierInvoiceTaxAndVariance1789910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "supplier_invoices" ADD COLUMN "taxAmount" NUMERIC(14,2) NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "supplier_invoices" ADD COLUMN "receiptValueBase" NUMERIC(18,4)`);
    await queryRunner.query(`ALTER TABLE "supplier_invoices" ADD COLUMN "ppvBase" NUMERIC(18,4)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "supplier_invoices" DROP COLUMN "ppvBase"`);
    await queryRunner.query(`ALTER TABLE "supplier_invoices" DROP COLUMN "receiptValueBase"`);
    await queryRunner.query(`ALTER TABLE "supplier_invoices" DROP COLUMN "taxAmount"`);
  }
}
