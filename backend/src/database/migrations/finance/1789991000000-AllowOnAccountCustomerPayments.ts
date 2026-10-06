import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CUS-01 (2026-10-06, CTO: Option 1 — reuse the existing AR control architecture). A customer payment may now be received BEFORE an invoice
 * exists (on-account / advance): `invoiceId` becomes nullable and an optional `salesOrderId` earmark is added. Existing rows are unchanged
 * (every one has an invoice). No new GL account; the unapplied credit lives in the Customer Ledger (`invoiceId = NULL`) exactly like a deposit.
 */
export class AllowOnAccountCustomerPayments1789991000000 implements MigrationInterface {
  name = 'AllowOnAccountCustomerPayments1789991000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "customer_payments" ALTER COLUMN "invoiceId" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "customer_payments" ADD COLUMN "salesOrderId" uuid`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "customer_payments" DROP COLUMN "salesOrderId"`);
    await queryRunner.query(`ALTER TABLE "customer_payments" ALTER COLUMN "invoiceId" SET NOT NULL`); // fails if on-account rows exist — by design
  }
}
