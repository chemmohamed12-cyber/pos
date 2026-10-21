import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { DataSource } from 'typeorm';

/**
 * TEST-ONLY helpers for the SaaS Control Plane characterization specs (WP-0.5a/b/c/d).
 * Not production code. Untracked evidence tooling.
 *
 * Safety rule enforced here (CTO: tests never target the shared dev server):
 * `assertIsolatedInstance()` throws unless DB_PORT points at an isolated instance: the original isolated
 * instance (127.0.0.1:5544) or the DB-guard-approved dedicated cluster (127.0.0.1:5546, the role the biz
 * runner sets, disposable names `daii_test_biz_tNN...` only) — the specs refuse to run against 5433 or an unset port.
 */
export const DB_HOST = process.env.DB_HOST ?? '';
export const DB_PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 0;
export const DB_USER = process.env.DB_USER ?? '';
export const DB_PASSWORD = process.env.DB_PASSWORD ?? '';
export const APP_ROOT = process.cwd();

const DEDICATED_BIZ_CLUSTER_PORT = 5546;
const DEDICATED_BIZ_CLUSTER_ROLE = 'daii_biz_test';
const DEDICATED_BIZ_CLUSTER_NAME = /^daii_test_biz_t[0-9]{2}[a-z0-9_]*$/;

export function assertIsolatedInstance(): void {
  const legacyIsolated = DB_PORT === 5544;
  const dedicatedBizCluster = DB_PORT === DEDICATED_BIZ_CLUSTER_PORT && DB_USER === DEDICATED_BIZ_CLUSTER_ROLE;
  if (DB_HOST !== '127.0.0.1' || !(legacyIsolated || dedicatedBizCluster) || !DB_USER || !DB_PASSWORD) {
    throw new Error('Refusing to run: these characterization specs only run against an isolated PostgreSQL instance (DB_HOST=127.0.0.1 and DB_PORT=5544, or the approved dedicated cluster DB_PORT=5546 with its biz role + credentials). Never the shared dev server.');
  }
}

/** On the dedicated cluster the DB guard approves only `daii_test_biz_tNN...` names; refuse anything else before sending a statement. */
function assertNameAllowedOnThisInstance(name: string): void {
  if (DB_PORT === DEDICATED_BIZ_CLUSTER_PORT && !DEDICATED_BIZ_CLUSTER_NAME.test(name)) {
    throw new Error(`Refusing: on the dedicated cluster only daii_test_biz_tNN... database names are allowed (got ${name})`);
  }
}

async function withAdmin<T>(fn: (admin: DataSource) => Promise<T>): Promise<T> {
  assertIsolatedInstance();
  const admin = new DataSource({ type: 'postgres', host: DB_HOST, port: DB_PORT, username: DB_USER, password: DB_PASSWORD, database: 'postgres', synchronize: false, logging: false });
  await admin.initialize();
  try {
    return await fn(admin);
  } finally {
    await admin.destroy();
  }
}

export const dbConfig = (database: string) => ({ host: DB_HOST, port: DB_PORT, username: DB_USER, password: DB_PASSWORD, database });

export async function createDisposableDatabase(name: string): Promise<void> {
  if (!/^daii_test_[a-z0-9_]+$/.test(name)) throw new Error(`Refusing to create non-disposable database name: ${name}`);
  assertNameAllowedOnThisInstance(name);
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
  });
}

export async function databaseExists(name: string): Promise<boolean> {
  return withAdmin(async (admin) => (await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name])).length > 0);
}

/** Drops a disposable database; retries once because teardown can race other sessions' connections. */
export async function dropDisposableDatabase(name: string): Promise<void> {
  if (!/^daii_test_[a-z0-9_]+$/.test(name)) throw new Error(`Refusing to drop non-disposable database name: ${name}`);
  assertNameAllowedOnThisInstance(name);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await withAdmin(async (admin) => {
        await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]).catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

export async function residueOf(prefix: string): Promise<string[]> {
  return withAdmin(async (admin) => (await admin.query(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [`${prefix}%`])).map((r: { datname: string }) => r.datname));
}

export async function tableExists(ds: DataSource, table: string): Promise<boolean> {
  return (await ds.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [table])).length > 0;
}

/** sha256 (first 16 hex) of one source file, relative to the backend root. */
export function hashFile(relPath: string): string {
  return createHash('sha256').update(readFileSync(join(APP_ROOT, relPath))).digest('hex').slice(0, 16);
}

/** One digest over every file under a directory (names + contents) — detects any concurrent change. */
export function hashTree(relDir: string): string {
  try {
    statSync(join(APP_ROOT, relDir));
  } catch {
    return 'absent';
  }
  const h = createHash('sha256');
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        h.update(relative(APP_ROOT, p));
        h.update(readFileSync(p));
      }
    }
  };
  walk(join(APP_ROOT, relDir));
  return h.digest('hex').slice(0, 16);
}

export class Recorder {
  readonly data: Record<string, unknown> = {};
  constructor() {
    // The migration runner loads the COMPILED `dist/database/migrations` — a rebuild by anyone else mid-run corrupts a result.
    // Record both digests at start and end of every spec so such a change is visible, never silent.
    this.data.migrationsAtStart = { src: hashTree('src/database/migrations'), dist: hashTree('dist/database/migrations') };
  }
  record(key: string, value: unknown): void {
    this.data[key] = value;
  }
  flush(label: string): void {
    this.data.migrationsAtEnd = { src: hashTree('src/database/migrations'), dist: hashTree('dist/database/migrations') };
    this.data.cwd = APP_ROOT;
    const file = process.env.WP05_RESULTS_DIR ? join(process.env.WP05_RESULTS_DIR, `${label}.json`) : null;
    if (file) writeFileSync(file, JSON.stringify(this.data, null, 2));
  }
}
