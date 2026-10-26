import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Org engine WP-A (decision D-A, option B, approved 2026-10-26) — the organizational attribution of a SUPPLIER payment is STAMPED when the payment is recorded, so its reversal
 * can mirror exactly what was posted (never today's branch of an invoice or account):
 *  - `supplier_payment_allocations.orgUnitId` — the branch of the invoice that allocation settles;
 *  - `supplier_payments.bankOrgUnitId`       — the branch of the paying treasury account.
 * Additive and nullable; no backfill — a payment recorded before this migration keeps NULL (its reversal then mirrors the unit-less original). Numbered after the
 * 1.1.13 line's newest migration (1790030400000).
 */
export class AddSupplierPaymentOrgAttribution1790031000000 implements MigrationInterface {
  name = 'AddSupplierPaymentOrgAttribution1790031000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "supplier_payment_allocations" ADD COLUMN IF NOT EXISTS "orgUnitId" uuid NULL`);
    await queryRunner.query(`ALTER TABLE "supplier_payments" ADD COLUMN IF NOT EXISTS "bankOrgUnitId" uuid NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "supplier_payments" DROP COLUMN IF EXISTS "bankOrgUnitId"`);
    await queryRunner.query(`ALTER TABLE "supplier_payment_allocations" DROP COLUMN IF EXISTS "orgUnitId"`);
  }
}
