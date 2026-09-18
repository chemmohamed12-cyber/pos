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
  // [0-9]* (not a bare *) deliberately excludes non-migration files that
  // live alongside the numbered migrations, e.g.
  // extension-dependencies.spec.ts (a Jest regression test, not a
  // migration) — a bare `*` glob here picked it up as a "migration" and
  // the CLI (running via ts-node) then failed trying to type-check a
  // Jest spec file outside a Jest run (TS2582, no describe/it/expect).
  // Every real migration filename starts with a 13-digit timestamp, so
  // this is a safe, explicit filter, not a workaround.
  migrations: [`${__dirname}/migrations/[0-9]*{.ts,.js}`],
  synchronize: false,
  logging: false,
};

export default new DataSource(dataSourceOptions);
