import { DataSource } from 'typeorm';
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
 * modules for THIS installation. Defaults to the full DAII_STANDARD set so
 * every existing caller keeps its current behaviour until it opts in to a
 * subset (the "apply entitlement manifest" deploy step, P6 T2, passes
 * `await readEnabledModules({ appRoot })`). The `<tag>/[0-9]*.js` shape
 * keeps the digit-anchor guarantee per directory (see
 * `src/database/data-source.ts`).
 */
export const ALL_MIGRATION_TAGS = ['core', 'sales', 'inventory', 'logistics', 'finance', 'hr'] as const;

export function createMigrationDataSource(
  appRoot: string,
  database: DatabaseConfig,
  tags: readonly string[] = ALL_MIGRATION_TAGS,
): DataSource {
  return new DataSource({
    type: 'postgres',
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    migrations: tags.map((tag) => join(appRoot, 'dist', 'database', 'migrations', tag, '[0-9]*.js')),
    synchronize: false,
    logging: false,
  });
}
