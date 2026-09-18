import { MigrationInterface, QueryRunner } from 'typeorm';

/** One default active cash account so the Deposit-approval flow has somewhere to post to immediately — Treasury still fully supports creating more from day one. */
export class SeedDefaultTreasuryAccount1755848200000 implements MigrationInterface {
  name = 'SeedDefaultTreasuryAccount1755848200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "treasury_accounts" ("code", "name", "type", "status") VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      ['MAIN-CASH', 'Main Cash', 'cash', 'active'],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "treasury_accounts" WHERE "code" = $1`, ['MAIN-CASH']);
  }
}
