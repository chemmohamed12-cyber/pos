import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Treasury Payment Types (CTO directive) — Account Type -> Accounts
 * hierarchy. `treasury_account_types` is data, not an enum, so a future
 * type is one row, never a Treasury Core rebuild. Seeds the three named
 * types (bank/cash/wallet) and backfills every existing account's old
 * `type` string into the matching new `accountTypeId`, then drops the
 * old column — no account loses its type classification.
 */
export class AddTreasuryAccountTypeHierarchy1755848800000 implements MigrationInterface {
  name = 'AddTreasuryAccountTypeHierarchy1755848800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "treasury_account_types" (
        "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_treasury_account_types" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_treasury_account_types_code" ON "treasury_account_types" ("code")`);

    const seed: Array<[string, string]> = [
      ['bank', 'حسابات بنكية'],
      ['cash', 'خزائن نقدية'],
      ['wallet', 'محافظ'],
    ];
    for (const [code, name] of seed) {
      await queryRunner.query(`INSERT INTO "treasury_account_types" ("code", "name") VALUES ($1, $2)`, [code, name]);
    }

    await queryRunner.query(`ALTER TABLE "treasury_accounts" ADD COLUMN "accountTypeId" UUID`);
    await queryRunner.query(`
      UPDATE "treasury_accounts" a
      SET "accountTypeId" = t."id"
      FROM "treasury_account_types" t
      WHERE t."code" = a."type"
    `);
    await queryRunner.query(`ALTER TABLE "treasury_accounts" ALTER COLUMN "accountTypeId" SET NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_treasury_accounts_accountTypeId" ON "treasury_accounts" ("accountTypeId")`);
    await queryRunner.query(`ALTER TABLE "treasury_accounts" DROP COLUMN "type"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "treasury_accounts" ADD COLUMN "type" VARCHAR(16)`);
    await queryRunner.query(`
      UPDATE "treasury_accounts" a
      SET "type" = t."code"
      FROM "treasury_account_types" t
      WHERE t."id" = a."accountTypeId"
    `);
    await queryRunner.query(`ALTER TABLE "treasury_accounts" ALTER COLUMN "type" SET NOT NULL`);
    await queryRunner.query(`DROP INDEX "IDX_treasury_accounts_accountTypeId"`);
    await queryRunner.query(`ALTER TABLE "treasury_accounts" DROP COLUMN "accountTypeId"`);
    await queryRunner.query(`DROP TABLE "treasury_account_types"`);
  }
}
