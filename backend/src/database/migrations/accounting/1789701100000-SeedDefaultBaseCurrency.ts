import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `accounting`-tagged (ADR-025). F01 Financial Foundation gap, surfaced by
 * the ADR-048 (Procurement) E2E verification gate: no migration ever
 * seeded a default base/functional currency, so a fresh installation (or
 * one where `accounting_currencies` was ever emptied by direct DB
 * manipulation outside the application — confirmed via `audit_records`
 * for this dev database: real `accounting.currency.created`/
 * `base_changed` events exist from 2026-09-10, the table is empty now,
 * and no application code path can ever delete a currency row) has NO
 * legitimate way to reach a working state again — `createCurrency` can't
 * recreate an existing code (PK conflict) and, before the companion
 * `CurrencyService.setBaseCurrency` correctness fix landed alongside this
 * migration, `setBaseCurrency` refused to designate a first-ever base
 * currency once ANY fiscal year existed, even though nothing was ever
 * posted against a real base currency for that fiscal year to invalidate.
 *
 * Idempotent both ways: inserts EGP only if it doesn't already exist
 * (`ON CONFLICT (code) DO NOTHING`), and promotes it to base ONLY if no
 * currency is currently marked base — never demotes an already-configured
 * installation's real choice.
 */
export class SeedDefaultBaseCurrency1789701100000 implements MigrationInterface {
  name = 'SeedDefaultBaseCurrency1789701100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "accounting_currencies" ("code", "name", "symbol", "decimalPlaces", "roundingMode", "isActive", "isBaseCurrency")
      VALUES ('EGP', 'Egyptian Pound', 'E£', 2, 'half_up', true, NOT EXISTS (SELECT 1 FROM "accounting_currencies" WHERE "isBaseCurrency" = true))
      ON CONFLICT (code) DO NOTHING
    `);
    await queryRunner.query(`
      UPDATE "accounting_currencies" SET "isBaseCurrency" = true
      WHERE "code" = 'EGP' AND NOT EXISTS (SELECT 1 FROM "accounting_currencies" WHERE "isBaseCurrency" = true)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Deliberately a no-op: reversing "which currency is base" is exactly the destructive,
    // history-invalidating action this migration exists to make safe to configure in the first
    // place — never undo it automatically. An operator who genuinely needs to change it uses
    // `POST /accounting/currencies/:code/set-base` (now correctly scoped to real changes only).
  }
}
