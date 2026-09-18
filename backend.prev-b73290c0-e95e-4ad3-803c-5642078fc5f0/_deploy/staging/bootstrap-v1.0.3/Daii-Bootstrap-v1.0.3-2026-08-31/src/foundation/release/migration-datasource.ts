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
export function createMigrationDataSource(appRoot: string, database: DatabaseConfig): DataSource {
  return new DataSource({
    type: 'postgres',
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    migrations: [join(appRoot, 'dist', 'database', 'migrations', '[0-9]*.js')],
    synchronize: false,
    logging: false,
  });
}
