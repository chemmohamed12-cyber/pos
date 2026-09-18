import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §6 — "لكن لا تعتبره
 * خزينة نقدية عادية", don't treat a custody account as normal cash):
 * a fourth `treasury_account_types` row, same seeding precedent as
 * `bank`/`cash`/`wallet` (migration 1755848800000). Reuses the existing
 * Account Type -> Accounts hierarchy — no Treasury Core change needed,
 * exactly the extensibility point that hierarchy was built for.
 */
export class SeedTreasuryCustodyAccountType1755849500000 implements MigrationInterface {
  name = 'SeedTreasuryCustodyAccountType1755849500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "treasury_account_types" ("code", "name") VALUES ($1, $2)`,
      ['custody', 'حسابات عهدة (شركات/سيارات شحن)'],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "treasury_account_types" WHERE "code" = 'custody'`);
  }
}
