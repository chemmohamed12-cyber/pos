import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-070 §9 — the payroll-side counterpart to
 * `1789702000000-AddTreasuryTransactionSupplierColumns.ts` (the exact
 * same precedent, applied to a new domain): `treasury_transactions`
 * already carries `customerId`/`salesOrderId` and `supplierId`/
 * `supplierInvoiceId` for the AR/AP-side cash movements; this adds the
 * parallel `employeeId`/`payrollRunId` pair the new `cashOutForEmployee`
 * contract method needs, so a Payroll disbursement's Treasury leg is
 * queryable/auditable the same way a Supplier Payment's already is.
 * Additive, nullable — every existing row keeps NULL, no data migration,
 * no change to any existing Treasury route's behaviour.
 */
export class AddTreasuryTransactionPayrollColumns1789741000000 implements MigrationInterface {
  name = 'AddTreasuryTransactionPayrollColumns1789741000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "treasury_transactions" ADD COLUMN "employeeId" UUID`);
    await queryRunner.query(`ALTER TABLE "treasury_transactions" ADD COLUMN "payrollRunId" UUID`);
    await queryRunner.query(`CREATE INDEX "IDX_treasury_transactions_employee_id" ON "treasury_transactions" ("employeeId") WHERE "employeeId" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_treasury_transactions_payroll_run_id" ON "treasury_transactions" ("payrollRunId") WHERE "payrollRunId" IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_treasury_transactions_payroll_run_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_treasury_transactions_employee_id"`);
    await queryRunner.query(`ALTER TABLE "treasury_transactions" DROP COLUMN "payrollRunId"`);
    await queryRunner.query(`ALTER TABLE "treasury_transactions" DROP COLUMN "employeeId"`);
  }
}
