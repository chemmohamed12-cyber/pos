import { MigrationInterface, QueryRunner } from 'typeorm';

/** Treasury / Financial Core — a distinct role from `admin`, per the directive's explicit "separate permissions for rep/finance/admin". */
export class SeedFinanceRole1755848100000 implements MigrationInterface {
  name = 'SeedFinanceRole1755848100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`INSERT INTO "roles" ("key") VALUES ($1) ON CONFLICT DO NOTHING`, ['finance']);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "roles" WHERE "key" = $1`, ['finance']);
  }
}
