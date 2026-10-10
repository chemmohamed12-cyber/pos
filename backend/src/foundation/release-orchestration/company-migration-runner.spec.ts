import { DataSource } from 'typeorm';
import { runMigrationsForDatabase } from './company-migration-runner';

/**
 * V7 Area 16's own Verification requirement: "Multi-company migration
 * dry-run against N disposable test databases." Not mocked — this test
 * creates two real, disposable Postgres databases on the local dev
 * server, runs the existing migration pipeline against each via the one
 * function Area 16 adds, and proves both that the reused pipeline
 * genuinely works against an arbitrary database and that migrating one
 * never touches the other.
 *
 * V7 Area 16 (2026-09-25) — the environment blocker is CLEARED: `daii`
 * was granted `CREATEDB` on this Postgres instance (verified via
 * `pg_roles.rolcreatedb = true`), so this suite now runs for real. See
 * `company-migration-runner.unit.spec.ts` for the mocked, logic-only
 * coverage that ran throughout the blocked period as supplementary (not
 * equivalent) evidence.
 */
const NS = process.env.DAII_TEST_DB_NS ?? ''; // regression runner namespace (biz_tNN_), see two-company-real-pg-harness.ts
const HOST = process.env.DB_HOST ?? 'localhost';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 5433;
const USERNAME = process.env.DB_USER ?? 'daii';
const PASSWORD = process.env.DB_PASSWORD ?? 'daii_dev_only';
const APP_ROOT = process.cwd();

const DB_A = `daii_test_${NS}area16_company_a`;
const DB_B = `daii_test_${NS}area16_company_b`;

async function withAdminConnection<T>(fn: (admin: DataSource) => Promise<T>): Promise<T> {
  const admin = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: 'postgres', synchronize: false, logging: false });
  await admin.initialize();
  try {
    return await fn(admin);
  } finally {
    await admin.destroy();
  }
}

async function createDatabase(name: string): Promise<void> {
  await withAdminConnection(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
  });
}

async function dropDatabase(name: string): Promise<void> {
  await withAdminConnection(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });
}

describe('runMigrationsForDatabase (Area 16, real disposable Postgres databases)', () => {
  jest.setTimeout(300_000);

  beforeAll(async () => {
    await createDatabase(DB_A);
    await createDatabase(DB_B);
  });

  afterAll(async () => {
    await dropDatabase(DB_A);
    await dropDatabase(DB_B);
  });

  it('runs the existing core migration pipeline, unmodified, against a fresh disposable database', async () => {
    const result = await runMigrationsForDatabase(APP_ROOT, { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: DB_A }, ['core']);
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.ranMigrationNames.length).toBeGreaterThan(0);
  });

  it('the migrated database actually has the expected tables (not a no-op success)', async () => {
    const ds = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: DB_A, synchronize: false, logging: false });
    await ds.initialize();
    try {
      const rows: Array<{ to_regclass: string | null }> = await ds.query(`SELECT to_regclass('public.users') AS to_regclass`);
      expect(rows[0]?.to_regclass).not.toBeNull();
    } finally {
      await ds.destroy();
    }
  });

  it('migrating Company B never touches Company A — no cross-company selection (proof point 4)', async () => {
    const dsA = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: DB_A, synchronize: false, logging: false });
    await dsA.initialize();
    let countBeforeA: number;
    try {
      const rows: Array<{ count: string }> = await dsA.query(`SELECT count(*)::text AS count FROM "migrations"`);
      countBeforeA = Number(rows[0].count);
    } finally {
      await dsA.destroy();
    }

    const resultB = await runMigrationsForDatabase(APP_ROOT, { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: DB_B }, ['core']);
    expect(resultB.success).toBe(true);

    const dsA2 = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: DB_A, synchronize: false, logging: false });
    await dsA2.initialize();
    try {
      const rows: Array<{ count: string }> = await dsA2.query(`SELECT count(*)::text AS count FROM "migrations"`);
      expect(Number(rows[0].count)).toBe(countBeforeA);
    } finally {
      await dsA2.destroy();
    }
  });

  it('re-running against an already-migrated database is a safe no-op (retry semantics)', async () => {
    const result = await runMigrationsForDatabase(APP_ROOT, { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: DB_A }, ['core']);
    expect(result.success).toBe(true);
    expect(result.ranMigrationNames).toEqual([]);
  });

  it('reports failure (not a thrown crash escaping the function) for an unreachable database', async () => {
    const result = await runMigrationsForDatabase(APP_ROOT, { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: `daii_test_${NS}area16_does_not_exist` }, ['core']);
    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
  });
});
