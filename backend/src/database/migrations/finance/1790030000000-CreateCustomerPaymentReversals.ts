import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T2 (2026-10-20) — additive: the one-per-payment reversal record (see CustomerPaymentReversal). No existing row is read, changed or backfilled; the table
 * starts empty. `paymentId` UNIQUE is the database-level guarantee against a double reversal. Down drops the (empty or append-only) table.
 */
export class CreateCustomerPaymentReversals1790030000000 implements MigrationInterface {
  name = 'CreateCustomerPaymentReversals1790030000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "customer_payment_reversals" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "reversalNumber" varchar(32) NOT NULL,
        "paymentId" uuid NOT NULL,
        "reason" text NOT NULL,
        "reversedByUserId" uuid NOT NULL,
        "treasuryReversalTransactionId" uuid NOT NULL,
        "amount" numeric(14,2) NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_customer_payment_reversals" PRIMARY KEY ("id"),
        CONSTRAINT "FK_customer_payment_reversals_payment" FOREIGN KEY ("paymentId") REFERENCES "customer_payments"("id")
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_customer_payment_reversals_number" ON "customer_payment_reversals" ("reversalNumber")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_customer_payment_reversals_payment" ON "customer_payment_reversals" ("paymentId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "customer_payment_reversals"`);
  }
}
