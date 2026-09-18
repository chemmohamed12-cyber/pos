import { DataSource } from 'typeorm';
import { readdirSync } from 'fs';
import { join } from 'path';
import { DatabaseConfig } from '../configuration/app-config.service';

/**
 * Fresh, short-lived DataSource scoped to `appRoot`'s CURRENT
 * `dist/database/migrations` contents at the moment it's called. Extracted
 * into its own module (rather than a private method on
 * `ReleaseExecutionService`) purely so tests can substitute a fake
 * DataSource-like object via `jest.mock('./migration-datasource', ...)` —
 * the same pattern this codebase already uses for `readAppVersion`
 * (`app-version.ts`) — without needing a real PostgreSQL connection or a
 * NestJS-DI-unfriendly injected factory function.
 *
 * See `ReleaseExecutionService`'s class doc comment for WHY this can't
 * reuse the app's own injected `DataSource`: that instance resolved its
 * `migrations` glob once at boot and can never see files a release
 * deploys onto disk mid-process-lifetime.
 */
/**
 * Per-module migration partitioning (ADR-025, P6). `tags` selects which
 * `migrations/<tag>/` directories are in scope — Core + the entitled
 * modules for THIS installation. When omitted, defaults to every tag
 * directory that actually exists on disk (`discoverMigrationTags` below) so
 * every existing caller keeps its current "run everything" behaviour until
 * it opts in to a subset (the "apply entitlement manifest" deploy step,
 * P6 T2, passes `await readEnabledModules({ appRoot })`). The
 * `<tag>/[0-9]*.js` shape keeps the digit-anchor guarantee per directory
 * (see `src/database/data-source.ts`).
 */
/**
 * Production Incident 2026-09-15 — CTO Directive (post-mortem, "no future
 * migration/tag drift may pass silently"). A hardcoded tag list (this file
 * used to export a static `ALL_MIGRATION_TAGS = ['core', 'sales', ...]`)
 * was missing `'accounting'` — 23 real migration files under
 * `dist/database/migrations/accounting/` were silently never globbed by
 * any deploy with no entitlement manifest applied (this project's actual
 * production configuration). The fix is not "add accounting to the list" —
 * a hand-maintained list can drift again for the next new tag exactly the
 * same way. The fix is that there IS no hand-maintained list anymore:
 * `discoverMigrationTags` reads the real `dist/database/migrations/`
 * directory structure at call time, so a `treasury/`/`qr/`/any future tag
 * directory is included the moment it exists on disk — zero code change,
 * zero constant to remember to update, by construction.
 */
export function discoverMigrationTags(appRoot: string): string[] {
  try {
    return readdirSync(join(appRoot, 'dist', 'database', 'migrations'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    // No migrations directory at all (e.g. a malformed/incomplete tree) — an
    // empty scope, not a crash here; the caller (Migration Preflight) is
    // where an empty-when-migrations-were-expected result becomes a BLOCKED
    // decision, not a silently-accepted "nothing to do."
    return [];
  }
}

export function createMigrationDataSource(appRoot: string, database: DatabaseConfig, tags?: readonly string[]): DataSource {
  const resolvedTags = tags ?? discoverMigrationTags(appRoot);
  return new DataSource({
    type: 'postgres',
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    migrations: resolvedTags.map((tag) => join(appRoot, 'dist', 'database', 'migrations', tag, '[0-9]*.js')),
    synchronize: false,
    logging: false,
  });
}
