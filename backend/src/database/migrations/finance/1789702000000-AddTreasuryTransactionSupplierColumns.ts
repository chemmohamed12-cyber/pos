import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * OP-Procurement/AP Blueprint (CTO ratification, Decision 1: APPROVED —
 * Option A, applied 2026-09-18). `treasury_transactions` already carries
 * `customerId`/`salesOrderId` (nullable, indexed) for the AR-side cash
 * movements `TreasuryService.cashIn`/`cashOut` record; this adds the
 * parallel `supplierId`/`supplierInvoiceId` pair the new
 * `cashOutForSupplier` contract method needs, so a Supplier Payment's
 * Treasury leg is queryable/auditable the same way a Customer Payment's
 * already is. Additive, nullable — every existing row keeps NULL, no data
 * migration, no change to any existing Treasury route's behaviour.
 */
export class AddTreasuryTransactionSupplierColumns1789702000000 implements MigrationInterface {
  name = 'AddTreasuryTransactionSupplierColumns1789702000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "treasury_transactions" ADD COLUMN "supplierId" UUID`);
    await queryRunner.query(`ALTER TABLE "treasury_transactions" ADD COLUMN "supplierInvoiceId" UUID`);
    await queryRunner.query(`CREATE INDEX "IDX_treasury_transactions_supplier_id" ON "treasury_transactions" ("supplierId") WHERE "supplierId" IS NOT NULL`);
    await queryRunner.query(
      `CREATE INDEX "IDX_treasury_transactions_supplier_invoice_id" ON "treasury_transactions" ("supplierInvoiceId") WHERE "supplierInvoiceId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_treasury_transactions_supplier_invoice_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_treasury_transactions_supplier_id"`);
    await queryRunner.query(`ALTER TABLE "treasury_transactions" DROP COLUMN "supplierInvoiceId"`);
    await queryRunner.query(`ALTER TABLE "treasury_transactions" DROP COLUMN "supplierId"`);
  }
}
