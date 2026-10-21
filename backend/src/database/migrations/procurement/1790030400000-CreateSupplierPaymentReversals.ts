import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T2-S (2026-10-21) — additive: the one-per-payment reversal record of a SUPPLIER payment (written by SupplierPaymentReversalService). No existing row is read, changed or backfilled;
 * the table starts empty. `supplierPaymentId` UNIQUE is the database-level guarantee against a double reversal. Lives in the procurement tag because it references
 * `supplier_payments` (created there). Down drops the (empty or append-only) table.
 */
export class CreateSupplierPaymentReversals1790030400000 implements MigrationInterface {
  name = 'CreateSupplierPaymentReversals1790030400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "supplier_payment_reversals" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "reversalNumber" varchar(32) NOT NULL,
        "supplierPaymentId" uuid NOT NULL,
        "reason" text NOT NULL,
        "reversedByUserId" uuid NOT NULL,
        "treasuryReversalTransactionId" uuid NOT NULL,
        "amount" numeric(14,2) NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_supplier_payment_reversals" PRIMARY KEY ("id"),
        CONSTRAINT "FK_supplier_payment_reversals_payment" FOREIGN KEY ("supplierPaymentId") REFERENCES "supplier_payments"("id")
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_supplier_payment_reversals_number" ON "supplier_payment_reversals" ("reversalNumber")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_supplier_payment_reversals_payment" ON "supplier_payment_reversals" ("supplierPaymentId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "supplier_payment_reversals"`);
  }
}
