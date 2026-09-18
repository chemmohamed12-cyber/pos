import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F06 / handoff F06-H1 (ADR-038 D7 = 7a). Additive — one nullable column
 * on `treasury_accounts` mapping a Treasury account to its General Ledger
 * account (`GLAccount.code`, a `bank` control account). Same "additive,
 * nullable, dormant until set" shape as F04-H1's E-02 columns on
 * `sales_invoices`.
 *
 * NULL = unmapped = the account's cash movements publish no
 * `treasury.*` GL event, and F06's Cash/Bank↔GL reconciliation reports
 * the account as "not GL-mapped". Backward compatible; every existing row
 * keeps `NULL`. No data migration. No change to any existing Treasury
 * route's behaviour.
 */
export class AddTreasuryAccountGlMapping1755855600000 implements MigrationInterface {
  name = 'AddTreasuryAccountGlMapping1755855600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "treasury_accounts" ADD COLUMN "glAccountCode" VARCHAR(32)`);
    await queryRunner.query(
      `CREATE INDEX "IDX_treasury_accounts_gl_account_code" ON "treasury_accounts" ("glAccountCode") WHERE "glAccountCode" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_treasury_accounts_gl_account_code"`);
    await queryRunner.query(`ALTER TABLE "treasury_accounts" DROP COLUMN "glAccountCode"`);
  }
}
