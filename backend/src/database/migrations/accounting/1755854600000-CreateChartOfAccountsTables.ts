import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F02 — Chart of Accounts (ADR-034). Two new tables owned exclusively by
 * `accounting` — zero cross-module reference in either direction, so no
 * `to_regclass` guard is needed (same reasoning as F01's
 * `CreateAccountingTables` and `hr`'s `CreateHrTables`). Purely additive;
 * touches nothing outside `accounting`.
 */
export class CreateChartOfAccountsTables1755854600000 implements MigrationInterface {
  name = 'CreateChartOfAccountsTables1755854600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_gl_accounts" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(160) NOT NULL,
        "accountType" VARCHAR(16) NOT NULL,
        "normalBalance" VARCHAR(6) NOT NULL,
        "isContra" BOOLEAN NOT NULL DEFAULT false,
        "parentAccountId" UUID,
        "isPostable" BOOLEAN NOT NULL DEFAULT true,
        "controlFunction" VARCHAR(24),
        "currencyMode" VARCHAR(16) NOT NULL DEFAULT 'functional_only',
        "restrictCurrencyCode" VARCHAR(3),
        "allowManualJournal" BOOLEAN NOT NULL DEFAULT true,
        "orgUnitId" UUID,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "description" VARCHAR(512),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_accounting_gl_accounts_account_type"
          CHECK ("accountType" IN ('asset','liability','equity','revenue','expense')),
        CONSTRAINT "CHK_accounting_gl_accounts_normal_balance"
          CHECK ("normalBalance" IN ('debit','credit')),
        CONSTRAINT "CHK_accounting_gl_accounts_currency_mode"
          CHECK ("currencyMode" IN ('functional_only','single_foreign','any')),
        CONSTRAINT "CHK_accounting_gl_accounts_single_foreign_needs_currency"
          CHECK (("currencyMode" = 'single_foreign') = ("restrictCurrencyCode" IS NOT NULL))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_accounting_gl_accounts_code" ON "accounting_gl_accounts" ("code")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_gl_accounts_parent" ON "accounting_gl_accounts" ("parentAccountId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_accounting_gl_accounts_control_function" ON "accounting_gl_accounts" ("controlFunction") WHERE "controlFunction" IS NOT NULL`,
    );
    // ADR-034 D4 — exactly one retained-earnings account per chart (belt-and-suspenders beyond the service check).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_gl_accounts_one_retained_earnings" ON "accounting_gl_accounts" ("controlFunction") WHERE "controlFunction" = 'retained_earnings'`,
    );

    await queryRunner.query(`
      CREATE TABLE "accounting_gl_account_dimension_rules" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "accountId" UUID NOT NULL,
        "dimensionTypeId" UUID NOT NULL,
        "mode" VARCHAR(10) NOT NULL,
        "defaultValueId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_accounting_gl_account_dimension_rules_mode"
          CHECK ("mode" IN ('required','optional','blocked'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_gl_account_dimension_rules_account_type" ON "accounting_gl_account_dimension_rules" ("accountId", "dimensionTypeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_accounting_gl_account_dimension_rules_account" ON "accounting_gl_account_dimension_rules" ("accountId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_gl_account_dimension_rules"`);
    await queryRunner.query(`DROP TABLE "accounting_gl_accounts"`);
  }
}
