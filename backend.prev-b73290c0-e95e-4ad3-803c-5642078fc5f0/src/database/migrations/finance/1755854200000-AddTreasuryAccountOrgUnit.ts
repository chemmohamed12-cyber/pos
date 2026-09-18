import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-031 — Scope Derivation Architecture (closes AUDIT-SEC-03 for
 * Treasury). Additive, behaviour-preserving by construction: NULL resolves
 * to "no branch assigned" = accessible to everyone, which is exactly every
 * existing installation's current behaviour (`ScopeResolver.assertAccess`'s
 * own `org_unit` branch). The tightening only takes effect once a customer
 * actually assigns an account to an org unit — `finance`-tagged (ADR-025)
 * because `treasury_accounts` is owned by the `finance` module (initially
 * placed under `core/` in error; `validate:migrations`' own C-MIG-2 check
 * caught it — corrected before this migration was ever applied anywhere).
 */
export class AddTreasuryAccountOrgUnit1755854200000 implements MigrationInterface {
  name = 'AddTreasuryAccountOrgUnit1755854200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "treasury_accounts" ADD COLUMN "orgUnitId" UUID NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_treasury_accounts_orgUnitId" ON "treasury_accounts" ("orgUnitId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_treasury_accounts_orgUnitId"`);
    await queryRunner.query(`ALTER TABLE "treasury_accounts" DROP COLUMN "orgUnitId"`);
  }
}
