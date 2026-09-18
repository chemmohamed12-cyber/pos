import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * First real migration — proves the migration mechanism works end to end
 * (Stage 2 build-order item 3). Intentionally not a business table: no
 * Foundation/Domain schema is designed yet (those land with their own
 * build-order items). This table exists only so `/health/db` has
 * something real to read, matching the "real round-trip check, not
 * hardcoded ok" discipline already used for the plain /health endpoint.
 */
export class BootstrapCheck1755840000000 implements MigrationInterface {
  name = 'BootstrapCheck1755840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "_daii_bootstrap_check" (
        "id" SERIAL PRIMARY KEY,
        "checked_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`INSERT INTO "_daii_bootstrap_check" DEFAULT VALUES`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "_daii_bootstrap_check"`);
  }
}
