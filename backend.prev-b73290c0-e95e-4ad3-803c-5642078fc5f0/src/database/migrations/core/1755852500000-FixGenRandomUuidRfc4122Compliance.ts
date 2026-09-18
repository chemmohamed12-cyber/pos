import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hotfix 5 (post-v1.0.2) — the ACTUAL root cause of "treasuryAccountId
 * must be a UUID" (and, latently, the same class of error on any other
 * `@IsUUID()`-validated field that round-trips a server-generated id
 * back through an API — traced live against the real deployed app, not
 * assumed from source alone; see HOTFIX_REPORT.md for the full trace).
 *
 * `CreateUsers1755840100000` replaced `gen_random_uuid()` (needed
 * because this hosting plan has neither PG13+ core support nor the
 * `pgcrypto` extension — see PRODUCTION_DEPLOYMENT_GUIDE.md "UUID
 * generation strategy") with:
 *
 *   SELECT md5(random()::text || clock_timestamp()::text)::uuid;
 *
 * This produces a string the right SHAPE for a UUID (32 hex digits,
 * correctly hyphenated 8-4-4-4-12), but RFC4122 also requires two
 * specific nibbles to carry fixed values: the first character of the
 * 3rd group must encode the version (1-5), and the first character of
 * the 4th group must encode the variant (8/9/a/b, binary `10xx`).
 * `md5()` output is unconstrained random hex, so those two nibbles land
 * on a valid value only by chance — empirically confirmed (100,000-
 * iteration simulation, this delta's dev machine): **only ~7.7% of
 * values this function has ever generated pass strict UUID validation**
 * (`class-validator`'s `@IsUUID()`, and any other RFC4122-conformant
 * check). Every `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` column
 * in this schema has been using exactly this function since that
 * migration ran — i.e. every table, not just treasury accounts. Most
 * ids are never affected in practice because they only ever flow as
 * internal FK references, never re-submitted by a client through a
 * `@IsUUID()`-gated field — Treasury/Deposit-Control's "pick an account
 * from a dropdown, submit its id back" pattern is exactly the shape of
 * usage that exposes it.
 *
 * Fix: keep the same "no extension, no PG-version assumption, core
 * functions only" constraint the original workaround already committed
 * to (`md5`/`random`/`clock_timestamp`, plus only core string/bit
 * functions — `substr`, string concatenation, and a hex-digit-to-bit
 * cast, all present since ancient PostgreSQL releases) — but force the
 * version nibble to `4` and the variant nibble to a randomly-chosen one
 * of `8`/`9`/`a`/`b`, matching how a real UUID v4 is actually
 * constructed. Verified (same 100,000-iteration simulation): **100%
 * pass validation, 100% unique across 20,000 samples** — no regression
 * in randomness/collision-safety, just the two mandated nibbles fixed.
 *
 * `CREATE OR REPLACE FUNCTION` takes effect for every INSERT from the
 * moment this migration runs onward — no application code change needed
 * anywhere, since every caller already just calls the (same-named)
 * function via the column default.
 *
 * IMPORTANT — disclosed, not silently glossed over: this fixes id
 * generation for every row created AFTER this migration runs. It does
 * NOT retroactively repair the ~92% of already-existing rows (created
 * before this fix) whose stored id happens to be non-compliant — the
 * specific treasury account this bug was reproduced against
 * (`A-10001`) is one of them, and will keep failing `@IsUUID()`
 * whenever its existing id is resubmitted, until that row's id is
 * deliberately regenerated. That is NOT done here: changing a primary
 * key value on a live table with foreign keys referencing it everywhere
 * is a separate, far riskier, deliberately-scoped operation (cascading
 * updates across every referencing table, verified one relation at a
 * time) — not something to bundle silently into a hotfix migration.
 * Flagged explicitly as required follow-up in HOTFIX_REPORT.md.
 *
 * Local Migration Blocker #2 (2026-09-08): on an instance where
 * `gen_random_uuid()` already exists and is owned by a DIFFERENT role
 * than the one running migrations (e.g. this delta's dev machine, where
 * `public.gen_random_uuid()` — or, on PostgreSQL 13+, the genuine
 * `pg_catalog` core builtin — is owned by `postgres` while migrations
 * run as `daii`), the unconditional `CREATE OR REPLACE FUNCTION` this
 * migration used to run fails with SQLSTATE 42501
 * ("must be owner of function gen_random_uuid"). That is PostgreSQL's
 * ownership model working exactly as designed, not a bug — the fix is
 * NOT `ALTER FUNCTION ... OWNER TO ...` (never done: changing ownership
 * to route around a permission check defeats the reason the check
 * exists) and NOT deleting/recreating the function outside a migration.
 *
 * Same principle as `UuidGenerateV4Compatibility1755840150000`'s own
 * ownership fix, extended with one more step because this migration's
 * job is to REPLACE a possibly-broken existing definition rather than
 * only create one when absent — a bare "skip if already exists" guard
 * would be wrong here, since it would also skip fixing a genuinely
 * non-compliant pre-existing function. `up()` therefore:
 *
 *   1. Resolves whatever `gen_random_uuid()` an unqualified call
 *      currently reaches (`to_regprocedure`, which honors `search_path`
 *      exactly like a real call does — `pg_catalog` before `public`).
 *   2. Empirically calls it and checks BOTH RFC4122 nibbles on that one
 *      sample. If already compliant — the expected case on PostgreSQL
 *      13+, whose genuine `pg_catalog` core builtin coexists with but is
 *      architecturally separate from anything a migration may have put
 *      in `public` — this is a no-op. Nothing is touched, exactly as
 *      `CreateUsers1755840100000`'s own doc comment already promised
 *      ("the real one wins there and this one simply sits unused").
 *   3. Only if NOT compliant: replaces the function if the current role
 *      already owns it (or no function exists yet at all) — a same-owner
 *      `CREATE OR REPLACE` is always permitted and changes nothing about
 *      ownership.
 *   4. If NOT compliant AND owned by a different role, raises a clear,
 *      actionable exception naming the blocking owner instead of letting
 *      PostgreSQL's raw 42501 propagate — and does not silently succeed
 *      without actually having fixed the compliance problem.
 *
 * `down()` mirrors the same ownership guard (never blind `CREATE OR
 * REPLACE`) before restoring the prior broken definition.
 */
export class FixGenRandomUuidRfc4122Compliance1755852500000 implements MigrationInterface {
  name = 'FixGenRandomUuidRfc4122Compliance1755852500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $do$
      DECLARE
        fn_oid oid;
        fn_owner text;
        sample_uuid text;
        version_nibble text;
        variant_nibble text;
        is_compliant boolean := false;
      BEGIN
        fn_oid := to_regprocedure('gen_random_uuid()');

        IF fn_oid IS NOT NULL THEN
          -- Empirically test whether the function an unqualified call
          -- currently reaches already produces RFC4122-compliant output,
          -- rather than assuming based on which schema/version it is.
          sample_uuid := gen_random_uuid()::text;
          version_nibble := substring(sample_uuid FROM 15 FOR 1);
          variant_nibble := substring(sample_uuid FROM 20 FOR 1);
          is_compliant := version_nibble = '4' AND variant_nibble IN ('8', '9', 'a', 'b');
        END IF;

        IF is_compliant THEN
          -- Already produces compliant output (typically PostgreSQL 13+'s
          -- own pg_catalog core builtin) — do not touch it.
          RETURN;
        END IF;

        IF fn_oid IS NOT NULL THEN
          SELECT proowner::regrole::text INTO fn_owner FROM pg_proc WHERE oid = fn_oid;
        END IF;

        IF fn_oid IS NULL OR fn_owner = current_user THEN
          EXECUTE $create$
            CREATE OR REPLACE FUNCTION gen_random_uuid() RETURNS uuid AS $body$
              SELECT (
                substr(h, 1, 8) || '-' ||
                substr(h, 9, 4) || '-' ||
                '4' || substr(h, 14, 3) || '-' ||
                substr('89ab', 1 + (('x' || substr(h, 17, 1))::bit(4)::int % 4), 1) || substr(h, 18, 3) || '-' ||
                substr(h, 21, 12)
              )::uuid
              FROM (
                SELECT md5(random()::text || clock_timestamp()::text)
                    || md5(clock_timestamp()::text || random()::text) AS h
              ) s;
            $body$ LANGUAGE sql VOLATILE
          $create$;
        ELSE
          RAISE EXCEPTION 'gen_random_uuid() is not RFC4122-compliant and is owned by role "%", not the migration role "%" — refusing to CREATE OR REPLACE without an ownership change (forbidden). Have role "%" apply this fix, or grant ownership of the function to "%" out of band, then re-run migrations.', fn_owner, current_user, fn_owner, current_user;
        END IF;
      END
      $do$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restores the exact prior (broken) definition — a rollback of this
    // migration is a rollback of the fix, not a table drop; no data loss
    // either way since this only ever changes a function body. Same
    // ownership guard as up(): never a blind CREATE OR REPLACE.
    await queryRunner.query(`
      DO $do$
      DECLARE
        fn_oid oid;
        fn_owner text;
      BEGIN
        fn_oid := to_regprocedure('gen_random_uuid()');

        IF fn_oid IS NOT NULL THEN
          SELECT proowner::regrole::text INTO fn_owner FROM pg_proc WHERE oid = fn_oid;
        END IF;

        IF fn_oid IS NULL OR fn_owner = current_user THEN
          EXECUTE $create$
            CREATE OR REPLACE FUNCTION gen_random_uuid() RETURNS uuid AS $body$
              SELECT md5(random()::text || clock_timestamp()::text)::uuid;
            $body$ LANGUAGE sql VOLATILE
          $create$;
        ELSE
          RAISE EXCEPTION 'gen_random_uuid() is owned by role "%", not the migration role "%" — refusing to CREATE OR REPLACE without an ownership change (forbidden). Have role "%" run this rollback, or grant ownership of the function to "%" out of band.', fn_owner, current_user, fn_owner, current_user;
        END IF;
      END
      $do$;
    `);
  }
}
