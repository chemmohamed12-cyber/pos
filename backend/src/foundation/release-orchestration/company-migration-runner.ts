import { MigrationExecutor } from 'typeorm';
import { createMigrationDataSource } from '../release/migration-datasource';
import { DatabaseConfig } from '../configuration/app-config.service';

export interface CompanyMigrationRunResult {
  success: boolean;
  ranMigrationNames: string[];
  error: string | null;
}

/**
 * Multi-Company Phase 3 V7, Area 16 (Per-Company Migrations). The one
 * function this Area adds — invokes the EXISTING, unmodified
 * single-database migration pipeline (`createMigrationDataSource` +
 * TypeORM's own `MigrationExecutor`/`runMigrations()`, the exact
 * mechanism `ReleaseExecutionService.runReleaseMigrations()` already
 * uses for the app's own database) against an arbitrary Company
 * `DatabaseConfig` instead. Deliberately does NOT write to
 * `release_migration_runs` — that table is keyed by `releaseId`, an
 * app-wide Release concept that does not apply to a Company's own
 * provisioning run. The caller (Area 4's `DatabaseProvisioningService`)
 * decides what to do with the result. No existing Release Engine file
 * is imported for its side effects or modified — only the two exported,
 * already-parameterized primitives (`createMigrationDataSource`,
 * TypeORM's own `MigrationExecutor`) are reused.
 */
export async function runMigrationsForDatabase(appRoot: string, database: DatabaseConfig, tags?: readonly string[]): Promise<CompanyMigrationRunResult> {
  const migrationDataSource = createMigrationDataSource(appRoot, database, tags);
  try {
    // `initialize()` is INSIDE the try block deliberately — an unreachable
    // Company database (wrong host/port/credential) fails here first, and
    // must still produce {success:false, error}, not an uncaught throw:
    // the caller (Area 4's DatabaseProvisioningService) relies on this
    // function never throwing, so it can always mark the registry FAILED.
    await migrationDataSource.initialize();
    const pending = await new MigrationExecutor(migrationDataSource).getPendingMigrations();
    const pendingNames = pending.map((m) => m.name);
    await migrationDataSource.runMigrations();
    return { success: true, ranMigrationNames: pendingNames, error: null };
  } catch (err) {
    return { success: false, ranMigrationNames: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (migrationDataSource.isInitialized) {
      await migrationDataSource.destroy();
    }
  }
}
