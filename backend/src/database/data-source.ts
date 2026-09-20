import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';

dotenv.config();

/**
 * PostgreSQL Foundation — Stage 2 build-order item 3.
 * Daii/architecture/DAII_DATA_ARCHITECTURE.md, ADR-003.
 *
 * CLI-only entrypoint for `npm run migration:*` (the TypeORM CLI runs
 * outside Nest's DI container, so it cannot inject AppConfigService —
 * this is the standard TypeORM pattern for every project, not a Daii
 * shortcut). The running application itself gets its config through the
 * real Configuration Engine via DatabaseModule's forRootAsync — see
 * src/database/database.module.ts. Both read the same env vars, kept
 * intentionally minimal here (no validation) since the CLI's own error
 * messages on a bad connection are already clear enough for an operator
 * running a migration by hand.
 */
const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
  username: process.env.DB_USER ?? 'daii',
  password: process.env.DB_PASSWORD ?? 'daii_dev_only',
  database: process.env.DB_NAME ?? 'daii_dev',
  entities: [`${__dirname}/../**/*.entity{.ts,.js}`],
  // Per-module migration partitioning (ADR-025, P6): migrations now live in
  // one subdirectory per tag — `migrations/core/`, `migrations/sales/`,
  // `migrations/inventory/`, `migrations/logistics/`, `migrations/finance/`.
  // The `<tag>/[0-9]*` shape keeps the v1.0.2 digit-anchor guarantee per
  // directory: a bare `*` here once picked up a Jest spec and broke
  // `migration:run` type-checking (TS2582). TypeORM still orders by the
  // numeric timestamp parsed from the class name, not the path, so global
  // ordering across all tag dirs is preserved.
  //
  // This CLI entrypoint (dev + `migration:run:prod`) globs EVERY tag — a
  // developer's / operator's DB by hand is always the full DAII_STANDARD
  // set. The per-Edition entitled subset is selected only by the Release
  // Engine's own DataSource (`foundation/release/migration-datasource.ts`),
  // which is the path a real per-customer install deploys through. Override
  // for a local subset test with DAII_MIGRATION_TAGS=core,sales.
  migrations: (process.env.DAII_MIGRATION_TAGS
    ? process.env.DAII_MIGRATION_TAGS.split(',').map((t) => t.trim()).filter(Boolean)
    : ['core', 'sales', 'inventory', 'logistics', 'finance', 'hr', 'accounting', 'procurement', 'manufacturing', 'attendance', 'payroll', 'targets', 'commission']
  ).map((tag) => `${__dirname}/migrations/${tag}/[0-9]*{.ts,.js}`),
  synchronize: false,
  logging: false,
};

export default new DataSource(dataSourceOptions);
