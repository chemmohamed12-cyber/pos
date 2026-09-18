import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Compatibility shim, not an extension install. Four later migrations
 * (CreateTreasuryTables, AddTreasuryAccountTypeHierarchy,
 * AddReturnsEngineCustomerReturns, AddCustomerFinancialCore) call
 * `uuid_generate_v4()`, which normally comes from the `uuid-ossp`
 * extension — but nothing in THIS repository's own migration history ever
 * runs `CREATE EXTENSION "uuid-ossp"` (a latent defect, unrelated to the
 * pgcrypto/hosting issue, that simply hadn't been reached yet). Since
 * `uuid-ossp` is equally unavailable on Namecheap Shared Stellar Plus
 * hosting (same missing-contrib-package cause as pgcrypto — see
 * PRODUCTION_DEPLOYMENT_GUIDE.md "UUID generation strategy"), this
 * defines `uuid_generate_v4()` as a thin SQL wrapper over the
 * PostgreSQL-core-native `gen_random_uuid()` (v13+, no extension). Both
 * produce a random (v4-format) UUID — functionally interchangeable for
 * every use in this codebase (primary key defaults only, never a
 * specific-version UUID requirement). This lets the four existing
 * migrations run completely unedited.
 *
 * Security Assurance Gate finding (2026-09-08): the original
 * unconditional `CREATE OR REPLACE FUNCTION` assumed `uuid_generate_v4()`
 * never exists yet — true for a database that has never had `uuid-ossp`
 * installed, but FALSE on any Postgres instance where a DIFFERENT
 * project, an earlier manual step, or the cluster's own template DB
 * already ran `CREATE EXTENSION "uuid-ossp"`. There, the REAL
 * extension-owned `uuid_generate_v4()` already exists, owned by whichever
 * role created the extension — and `CREATE OR REPLACE FUNCTION` requires
 * being that owner (or superuser), so a least-privilege application/
 * migration role correctly gets a permission error from Postgres itself.
 * **The fix is not to change that function's ownership** (`ALTER
 * FUNCTION ... OWNER TO ...`) — doing so would sever the function from
 * `uuid-ossp`'s own extension bookkeeping (`pg_depend`), breaking a clean
 * `DROP EXTENSION "uuid-ossp"` later and blurring an extension/
 * application ownership boundary that should stay clean. The correct fix
 * is for this migration to check first and do nothing if a
 * `uuid_generate_v4()` already exists from ANY source — our own shim is
 * only needed when one doesn't exist at all.
 */
export class UuidGenerateV4Compatibility1755840150000 implements MigrationInterface {
  name = 'UuidGenerateV4Compatibility1755840150000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `to_regprocedure` resolves a real, already-existing function
    // (ours from a prior run of this migration, OR uuid-ossp's own) —
    // NULL only when no `uuid_generate_v4()` exists anywhere yet. Only
    // that case creates the shim; every other case is a no-op, so this
    // is safe to run against a clean install, a database that already
    // has our shim, or a database where `uuid-ossp` is genuinely
    // installed — never touching a function this migration didn't create.
    // The `CREATE FUNCTION` itself runs via `EXECUTE` on a dollar-quoted
    // string (distinct tag from the outer `DO` block) rather than as a
    // bare statement inside the block — deliberately the more
    // conservative, unambiguous choice for a DDL statement that itself
    // needs a nested dollar-quoted function body, verifiable by reading
    // rather than requiring a live Postgres instance to confirm parses.
    await queryRunner.query(`
      DO $do$
      BEGIN
        IF to_regprocedure('uuid_generate_v4()') IS NULL THEN
          EXECUTE $create$
            CREATE FUNCTION uuid_generate_v4()
            RETURNS uuid
            AS $body$
              SELECT gen_random_uuid();
            $body$
            LANGUAGE sql VOLATILE
          $create$;
        END IF;
      END
      $do$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Mirror of `up()`'s safety: never drop a `uuid_generate_v4()` that
    // belongs to an extension (`pg_depend.deptype = 'e'`) — only remove
    // one this migration may have created itself as a standalone
    // (non-extension-owned) function.
    await queryRunner.query(`
      DO $do$
      BEGIN
        IF to_regprocedure('uuid_generate_v4()') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend d
             WHERE d.objid = to_regprocedure('uuid_generate_v4()')
               AND d.deptype = 'e'
           )
        THEN
          DROP FUNCTION uuid_generate_v4();
        END IF;
      END
      $do$;
    `);
  }
}
