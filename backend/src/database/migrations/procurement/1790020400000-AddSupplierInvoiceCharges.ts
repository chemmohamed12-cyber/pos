import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase C-2 (owner decisions D3 / E1, 2026-10-20) - discount, freight and other charges on a supplier invoice. Purely additive: four columns with neutral defaults, so every existing invoice
 * reads as "no discount, no freight, no other charges" and keeps its figures exactly. `freightTreatment` says whether the freight is capitalised into inventory ('capitalize', the default
 * per D3) or expensed together with the other charges ('expense'). `down` drops the columns (no document, number, amount or journal of an existing invoice is touched).
 */
export class AddSupplierInvoiceCharges1790020400000 implements MigrationInterface {
  name = 'AddSupplierInvoiceCharges1790020400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "supplier_invoices" ADD COLUMN IF NOT EXISTS "discountAmount" NUMERIC(14,2) NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "supplier_invoices" ADD COLUMN IF NOT EXISTS "freightAmount" NUMERIC(14,2) NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "supplier_invoices" ADD COLUMN IF NOT EXISTS "otherChargesAmount" NUMERIC(14,2) NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "supplier_invoices" ADD COLUMN IF NOT EXISTS "freightTreatment" VARCHAR(12) NOT NULL DEFAULT 'capitalize'`);
    await queryRunner.query(`ALTER TABLE "supplier_invoices" DROP CONSTRAINT IF EXISTS "CHK_supplier_invoices_charges"`);
    await queryRunner.query(`
      ALTER TABLE "supplier_invoices" ADD CONSTRAINT "CHK_supplier_invoices_charges" CHECK (
        "discountAmount" >= 0 AND "freightAmount" >= 0 AND "otherChargesAmount" >= 0 AND "freightTreatment" IN ('capitalize','expense')
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "supplier_invoices" DROP CONSTRAINT IF EXISTS "CHK_supplier_invoices_charges"`);
    for (const col of ['discountAmount', 'freightAmount', 'otherChargesAmount', 'freightTreatment']) {
      await queryRunner.query(`ALTER TABLE "supplier_invoices" DROP COLUMN IF EXISTS "${col}"`);
    }
  }
}
