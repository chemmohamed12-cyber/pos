import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression guard for the 2026-08-27 production incident: `pgcrypto`
 * (and, latently, `uuid-ossp`) turned out to be unavailable on
 * Namecheap Shared Stellar Plus hosting, and this wasn't discovered
 * until a live production migration run failed. This test makes that
 * class of failure fail CI instead — any new migration that introduces
 * a `CREATE EXTENSION` statement, or calls a function that only exists
 * via an extension, must be explicitly added to the allow-lists below.
 * Silence is not an option for this category of dependency: shared
 * hosting can silently lack any given extension, and finding out via a
 * production `migration:run` is the exact failure mode this guards
 * against.
 *
 * Approved UUID generation strategy (see
 * PRODUCTION_DEPLOYMENT_GUIDE.md "UUID generation strategy" for the
 * full rationale — including why this does NOT rely on any PostgreSQL
 * version: production turned out to be 10.23, not the 13+ originally
 * assumed, so `gen_random_uuid()` isn't core here either): every
 * primary key default uses either `gen_random_uuid()`, defined directly
 * in `1755840100000-CreateUsers.ts` as a plain SQL function using only
 * `md5`/`random`/`clock_timestamp` (present in every PostgreSQL
 * version), or `uuid_generate_v4()`, which
 * `1755840150000-UuidGenerateV4Compatibility.ts` defines as a thin SQL
 * wrapper over that same `gen_random_uuid()` — not an installation of
 * the `uuid-ossp` extension. No migration should ever run
 * `CREATE EXTENSION` for anything.
 */
describe('migration extension dependencies', () => {
  const MIGRATIONS_DIR = __dirname;

  // No approved extensions at all — the entire point of the 2026-08-27
  // fix was to stop depending on any PostgreSQL extension. If a future
  // migration has a genuine, reviewed need for one, add it here with a
  // comment explaining why shared-hosting compatibility was confirmed.
  const APPROVED_EXTENSIONS: string[] = [];

  // Functions that only exist via an extension, mapped to the
  // extension that (normally) provides them. A migration calling one
  // of these without a corresponding compatibility shim (like
  // uuid_generate_v4's) would fail the same way pgcrypto did.
  const EXTENSION_ONLY_FUNCTIONS: Record<string, string> = {
    // gen_random_uuid: intentionally NOT listed — this repo defines its
    // own version-independent implementation directly in CreateUsers
    // (see class doc above), so it needs no extension on any PG version.
    // uuid_generate_v4: intentionally NOT listed — this repo defines
    // its own compatibility wrapper (see class doc above), so a raw
    // call to it is expected and safe.
    crypt: 'pgcrypto',
    digest: 'pgcrypto',
    hmac: 'pgcrypto',
    pgp_sym_encrypt: 'pgcrypto',
    pgp_sym_decrypt: 'pgcrypto',
    uuid_generate_v1: 'uuid-ossp',
    uuid_generate_v3: 'uuid-ossp',
    uuid_generate_v5: 'uuid-ossp',
    unaccent: 'unaccent',
    similarity: 'pg_trgm',
  };

  function migrationFiles(): string[] {
    return fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
  }

  /**
   * Every migration in this repo writes SQL exclusively as
   * queryRunner.query(`...`) template literals — never string
   * concatenation or .query('...') with single/double quotes. Scanning
   * only backtick-delimited contents (not the whole file) avoids false
   * positives from doc comments that *discuss* an extension in prose
   * rather than actually calling it — but comments in this codebase
   * also use markdown-style single-backtick code spans (e.g. this very
   * file's own doc comments), so block/line comments must be stripped
   * FIRST, or those inline-code backticks get mistaken for SQL.
   */
  function sqlBodiesOf(content: string): string {
    const withoutComments = content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    return Array.from(withoutComments.matchAll(/`([^`]*)`/gs))
      .map((m) => m[1])
      .join('\n');
  }

  it('has migration files to check (sanity check that this test isn\'t silently a no-op)', () => {
    expect(migrationFiles().length).toBeGreaterThan(50);
  });

  it('never runs CREATE EXTENSION for anything not on the approved list', () => {
    const offenders: string[] = [];
    for (const file of migrationFiles()) {
      const sql = sqlBodiesOf(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      const matches = sql.matchAll(/CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z0-9_-]+)"?/gi);
      for (const m of matches) {
        const ext = m[1].toLowerCase();
        if (!APPROVED_EXTENSIONS.includes(ext)) {
          offenders.push(`${file}: CREATE EXTENSION "${ext}" is not on the approved list`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never calls an extension-only function without that extension being approved', () => {
    const offenders: string[] = [];
    for (const file of migrationFiles()) {
      const sql = sqlBodiesOf(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      for (const [fn, ext] of Object.entries(EXTENSION_ONLY_FUNCTIONS)) {
        const callPattern = new RegExp(`\\b${fn}\\s*\\(`, 'i');
        if (callPattern.test(sql) && !APPROVED_EXTENSIONS.includes(ext)) {
          offenders.push(`${file}: calls ${fn}() which requires unapproved extension "${ext}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
