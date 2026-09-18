import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Identity — Stage 2 build-order item 5.
 *
 * The `CREATE EXTENSION IF NOT EXISTS "pgcrypto"` statement originally
 * here was removed 2026-08-27: Namecheap confirmed `pgcrypto` is not
 * available on Shared Stellar Plus hosting (no .control file on the
 * server at all — not a permissions issue). Safe to edit: this
 * migration's own transaction rolled back on the failing
 * `CREATE EXTENSION` statement (confirmed live 2026-08-28: production's
 * `migrations` table has zero rows), and TypeORM records a migration as
 * executed inside that same transaction — a rolled-back transaction
 * cannot have left a row there.
 *
 * `gen_random_uuid()` originally assumed PostgreSQL 13+ core support
 * (added in that version, no extension needed) — but production's
 * actual `SHOW server_version` came back **10.23**, confirmed 2026-08-28,
 * and a live `SELECT gen_random_uuid();` on that server fails with
 * "function gen_random_uuid() does not exist". So instead of relying on
 * ANY PostgreSQL version or extension, this defines `gen_random_uuid()`
 * itself as a plain SQL function using only core functions that have
 * existed since ancient PostgreSQL releases (`md5`, `random`,
 * `clock_timestamp` — all present in PG10 and every version since).
 * This is version-independent: on a server where core/`pgcrypto`
 * already provides `gen_random_uuid()`, `pg_catalog` is always searched
 * before `public` for an unqualified call, so the real one wins there
 * and this one simply sits unused — no conflict either way. See
 * PRODUCTION_DEPLOYMENT_GUIDE.md "UUID generation strategy".
 */
export class CreateUsers1755840100000 implements MigrationInterface {
  name = 'CreateUsers1755840100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gen_random_uuid() RETURNS uuid AS $$
        SELECT md5(random()::text || clock_timestamp()::text)::uuid;
      $$ LANGUAGE sql VOLATILE;
    `);
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "fullName" VARCHAR(255) NOT NULL,
        "email" VARCHAR(255) NOT NULL,
        "mobile" VARCHAR(32),
        "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_users_email" ON "users" ("email")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
