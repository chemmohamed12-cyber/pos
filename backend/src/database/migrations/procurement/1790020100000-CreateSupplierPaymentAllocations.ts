import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Procurement invoicing redesign, phase B (CTO-approved 2026-10-20) - one supplier payment over several supplier invoices.
 *
 * New table `supplier_payment_allocations` (payment, invoice, amount). Every existing payment settled exactly one invoice (`supplier_payments.supplierInvoiceId`), so the backfill is a FACT, not an
 * inference: one row per payment with that invoice and the whole payment amount. It touches no amount, balance, journal, number or ledger entry and inserts nothing on a second run (unique key).
 * `supplier_payments.supplierInvoiceId` stays (the primary invoice) so old screens, reports and APIs keep working. `down` drops the table.
 */
export class CreateSupplierPaymentAllocations1790020100000 implements MigrationInterface {
  name = 'CreateSupplierPaymentAllocations1790020100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "supplier_payment_allocations" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "supplierPaymentId" UUID NOT NULL REFERENCES "supplier_payments"("id") ON DELETE CASCADE,
        "supplierInvoiceId" UUID NOT NULL REFERENCES "supplier_invoices"("id"),
        "amount" NUMERIC(14,2) NOT NULL CHECK ("amount" > 0),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_supplier_payment_allocations_pair" ON "supplier_payment_allocations" ("supplierPaymentId", "supplierInvoiceId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_supplier_payment_allocations_payment" ON "supplier_payment_allocations" ("supplierPaymentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_supplier_payment_allocations_invoice" ON "supplier_payment_allocations" ("supplierInvoiceId")`);
    await queryRunner.query(
      `INSERT INTO "supplier_payment_allocations" ("supplierPaymentId", "supplierInvoiceId", "amount")
       SELECT p."id", p."supplierInvoiceId", p."amount" FROM "supplier_payments" p
        ON CONFLICT DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "supplier_payment_allocations"`);
  }
}
