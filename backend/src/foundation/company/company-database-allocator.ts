import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

/**
 * Where a new Company's PostgreSQL database comes from (production, release 1.1.5: `no pg_hba.conf entry for ... user "xnexdrgr_daii_app2", database "postgres"`).
 *
 *   create = `CREATE DATABASE` through the maintenance database. Needs a role that may connect to it and has CREATEDB — the application's own role on a normal
 *            server, or a dedicated admin role (`COMPANY_DB_ADMIN_USER` / `COMPANY_DB_ADMIN_PASSWORD`) where the application role is restricted. The default.
 *   pool   = shared hosting (cPanel) where databases can only be created through the provider's own tooling and the application role cannot reach the maintenance
 *            database. The operator pre-creates EMPTY databases through the provider and lists them in `COMPANY_DB_POOL`; a Company claims the first one that is not
 *            yet registered, still empty, and reachable with the application's credentials. No PostgreSQL security control is bypassed.
 */
export interface CompanyDatabaseConfig {
  mode: 'create' | 'pool';
  maintenanceDatabase: string;
  adminUser: string | null;
  adminPassword: string | null;
  pool: string[];
}

export interface ConnectionTarget {
  host: string;
  port: number;
  username: string;
  password: string;
}

export class CompanyDatabaseAllocationError extends Error {
  constructor(readonly code: 'COMPANY_DATABASE_CREATION_FAILED' | 'COMPANY_DATABASE_POOL_EXHAUSTED', message: string, readonly detail: string) {
    super(message);
  }
}

const SAFE_NAME = /^[A-Za-z0-9_]{1,63}$/;

export function parseCompanyDatabasePool(raw: string | undefined | null): string[] {
  if (raw === undefined || raw === null || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config COMPANY_DB_POOL is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string' || !SAFE_NAME.test(x))) {
    throw new Error('Config COMPANY_DB_POOL must be a JSON array of database names (letters, digits, underscore; max 63 characters).');
  }
  return [...new Set(parsed as string[])];
}

async function withConnection<T>(target: ConnectionTarget, database: string, fn: (ds: DataSource) => Promise<T>): Promise<T> {
  const ds = new DataSource({ type: 'postgres', host: target.host, port: target.port, username: target.username, password: target.password, database, synchronize: false, logging: false });
  await ds.initialize();
  try {
    return await fn(ds);
  } finally {
    await ds.destroy();
  }
}

/** Serialises allocations inside this process so two concurrent creations cannot claim the same pooled database. */
let allocationChain: Promise<unknown> = Promise.resolve();
export function serializeAllocation<T>(fn: () => Promise<T>): Promise<T> {
  const run = allocationChain.then(fn, fn);
  allocationChain = run.catch(() => undefined);
  return run;
}

export async function allocateCompanyDatabase(
  cfg: CompanyDatabaseConfig,
  app: ConnectionTarget,
  usedDatabaseNames: () => Promise<string[]>,
): Promise<{ databaseName: string; origin: 'created' | 'pooled' }> {
  return cfg.mode === 'pool' ? claimFromPool(cfg, app, await usedDatabaseNames()) : createDatabase(cfg, app);
}

async function createDatabase(cfg: CompanyDatabaseConfig, app: ConnectionTarget): Promise<{ databaseName: string; origin: 'created' }> {
  const databaseName = `company_${randomUUID().replace(/-/g, '')}`;
  const admin: ConnectionTarget = cfg.adminUser ? { ...app, username: cfg.adminUser, password: cfg.adminPassword ?? '' } : app;
  try {
    await withConnection(admin, cfg.maintenanceDatabase, (ds) => ds.query(`CREATE DATABASE "${databaseName}"`));
  } catch (err) {
    throw new CompanyDatabaseAllocationError(
      'COMPANY_DATABASE_CREATION_FAILED',
      'The Company database could not be created, so nothing was created. The database role must be allowed to connect to the maintenance database and hold CREATEDB; on a shared host that does not allow this, set COMPANY_DB_MODE=pool and pre-create databases through the hosting provider.',
      err instanceof Error ? err.message : String(err),
    );
  }
  return { databaseName, origin: 'created' };
}

async function claimFromPool(cfg: CompanyDatabaseConfig, app: ConnectionTarget, used: string[]): Promise<{ databaseName: string; origin: 'pooled' }> {
  const usedSet = new Set(used);
  const skipped: string[] = [];
  for (const name of cfg.pool) {
    if (usedSet.has(name)) {
      skipped.push(`${name}: already assigned to a Company`);
      continue;
    }
    try {
      const tables = await withConnection(app, name, (ds) =>
        ds.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')`),
      );
      if (tables[0].n > 0) {
        skipped.push(`${name}: not empty (${tables[0].n} tables) — refusing to use a database that already holds data`);
        continue;
      }
    } catch (err) {
      skipped.push(`${name}: not reachable with the application's credentials (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    return { databaseName: name, origin: 'pooled' };
  }
  throw new CompanyDatabaseAllocationError(
    'COMPANY_DATABASE_POOL_EXHAUSTED',
    cfg.pool.length === 0
      ? 'No database is available for a new Company: COMPANY_DB_MODE=pool but COMPANY_DB_POOL is empty. Create an empty database through the hosting provider, grant the application role access to it and add its name to COMPANY_DB_POOL.'
      : 'No database is available for a new Company: every database in COMPANY_DB_POOL is already assigned, not empty or not reachable. Create another empty database through the hosting provider and add it to COMPANY_DB_POOL.',
    skipped.join('; '),
  );
}
