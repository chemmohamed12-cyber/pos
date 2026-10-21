import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { runMigrationsForDatabase } from '../release-orchestration/company-migration-runner';
import { discoverMigrationTags } from './migration-datasource';
import { checkCompanySchema, checkCompanySchemaInProcess, hasFindings } from './company-schema-check';

/**
 * Company schema check against REAL Postgres and the REAL compiled repository (CTO 2026-10-21). Needs `npm run build` first (it loads `dist/`). The point of this spec
 * is the failure mode a heuristic check has: FALSE POSITIVES. A genuinely healthy Company database must produce zero findings - including a Company that never
 * received an optional module - otherwise the gate would block healthy releases and be switched off. Then the two real incident shapes must be detected by name:
 *   - a missing COLUMN on an existing table (1.1.10: `column Product.itemType does not exist`), and
 *   - a missing TABLE that the Company's received migrations create (1.1.11: cash sessions / treasury documents).
 * Disposable databases `daii_test_<ns>sc_*` only; the isolated instance only.
 */
const HOST = process.env.DB_HOST ?? '127.0.0.1';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 0;
const USERNAME = process.env.DB_USER ?? '';
const PASSWORD = process.env.DB_PASSWORD ?? '';
const NS = process.env.DAII_TEST_DB_NS ?? '';
const PREFIX = `daii_test_${NS}sc_${randomUUID().slice(0, 8)}`;
const describeIsolated = PORT && PORT !== 5433 && USERNAME ? describe : describe.skip;

describeIsolated('Company schema check — real Postgres, real compiled repository', () => {
  jest.setTimeout(600_000);
  const dbCfg = (database: string) => ({ host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database });
  const created: string[] = [];
  async function admin<T>(fn: (ds: DataSource) => Promise<T>): Promise<T> {
    const ds = new DataSource({ type: 'postgres', ...dbCfg('postgres'), synchronize: false, logging: false });
    await ds.initialize();
    try {
      return await fn(ds);
    } finally {
      await ds.destroy();
    }
  }
  async function onDb<T>(db: string, fn: (ds: DataSource) => Promise<T>): Promise<T> {
    const ds = new DataSource({ type: 'postgres', ...dbCfg(db), synchronize: false, logging: false });
    await ds.initialize();
    try {
      return await fn(ds);
    } finally {
      await ds.destroy();
    }
  }
  async function freshCompanyDb(suffix: string, tags: string[]): Promise<string> {
    const db = `${PREFIX}_${suffix}`;
    await admin((ds) => ds.query(`CREATE DATABASE "${db}"`));
    created.push(db);
    const r = await runMigrationsForDatabase(process.cwd(), dbCfg(db), tags);
    if (!r.success) throw new Error(`fixture migration failed: ${r.error}`);
    return db;
  }
  const check = (db: string, tags: string[]) => checkCompanySchema(process.cwd(), dbCfg(db), tags, process.execPath, 240_000);

  const ALL_TAGS = discoverMigrationTags(process.cwd());
  let healthy: string;

  beforeAll(async () => {
    healthy = await freshCompanyDb('all', ALL_TAGS);
  });
  afterAll(async () => {
    await admin(async (ds) => {
      for (const db of created) await ds.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    });
  });

  it('NO FALSE POSITIVES: a Company database migrated by the real migrations of every tag has ZERO findings, and the check actually looked at many tables', async () => {
    const r = await check(healthy, ALL_TAGS);
    expect(r.error).toBeUndefined();
    expect(r.ran).toBe(true);
    expect(r.checkedTables).toBeGreaterThan(100);
    expect(r.findings).toEqual({ missingTables: [], missingColumns: {} });
  });

  it('a Company that never received an optional module (no manufacturing / hr / payroll ...) is NOT a finding: tables of modules it never had are not expected', async () => {
    const tags = ['core', 'sales', 'inventory', 'finance', 'procurement', 'accounting'].filter((t) => ALL_TAGS.includes(t));
    const db = await freshCompanyDb('partial', tags);
    const r = await check(db, tags);
    expect(r.ran).toBe(true);
    expect(r.findings).toEqual({ missingTables: [], missingColumns: {} });
  });

  it('a MISSING COLUMN on an existing table is reported by table and column name (the 1.1.10 incident class: Product.itemType)', async () => {
    const db = await freshCompanyDb('col', ALL_TAGS);
    const col = await onDb(db, async (ds) => {
      const rows: Array<{ column_name: string }> = await ds.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'itemType'`);
      if (rows.length === 0) throw new Error('fixture assumption: products."itemType" exists in the real schema');
      await ds.query(`ALTER TABLE "products" DROP COLUMN "itemType"`);
      return 'itemType';
    });
    const r = await check(db, ALL_TAGS);
    expect(r.ran).toBe(true);
    expect(hasFindings(r.findings)).toBe(true);
    expect(r.findings.missingColumns.products).toContain(col);
    expect(r.findings.missingTables).toEqual([]);
  });

  it('a MISSING TABLE that the received migrations create is reported (the 1.1.11 class: the cash-session / treasury tables)', async () => {
    const db = await freshCompanyDb('tbl', ALL_TAGS);
    const dropped = await onDb(db, async (ds) => {
      const rows: Array<{ tablename: string }> = await ds.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('cash_sessions','bank_statements','treasury_documents') ORDER BY 1 LIMIT 1`);
      if (rows.length === 0) throw new Error('fixture assumption: a treasury table exists in the real schema');
      await ds.query(`DROP TABLE "${rows[0].tablename}" CASCADE`);
      return rows[0].tablename;
    });
    const r = await check(db, ALL_TAGS);
    expect(r.ran).toBe(true);
    expect(r.findings.missingTables).toContain(dropped);
  });

  it('the check is READ-ONLY: running it changes nothing (same table / column / migration fingerprint before and after)', async () => {
    const fp = () =>
      onDb(healthy, async (ds) => {
        const cols: Array<{ n: string }> = await ds.query(`SELECT count(*)::text n FROM information_schema.columns WHERE table_schema = 'public'`);
        const mig: Array<{ n: string }> = await ds.query(`SELECT count(*)::text n FROM migrations`);
        const tables: Array<{ n: string }> = await ds.query(`SELECT count(*)::text n FROM pg_tables WHERE schemaname = 'public'`);
        return [cols[0].n, mig[0].n, tables[0].n];
      });
    const before = await fp();
    await check(healthy, ALL_TAGS);
    expect(await fp()).toEqual(before);
  });

  it('the IN-PROCESS fallback gives exactly the child-process result (healthy and with a missing column + a missing table), and is used when the child cannot start', async () => {
    const same = async (db: string) => {
      const child = await check(db, ALL_TAGS);
      const inProc = await checkCompanySchemaInProcess(process.cwd(), dbCfg(db), ALL_TAGS);
      expect(inProc.ran).toBe(true);
      expect(inProc.via).toBe('in_process');
      expect({ checked: inProc.checkedTables, findings: inProc.findings }).toEqual({ checked: child.checkedTables, findings: child.findings });
      return inProc;
    };
    expect(hasFindings((await same(healthy)).findings)).toBe(false);
    const db = await freshCompanyDb('inproc', ALL_TAGS);
    await onDb(db, async (ds) => {
      await ds.query(`ALTER TABLE "products" DROP COLUMN "itemType"`);
      await ds.query(`DROP TABLE "cash_sessions" CASCADE`);
    });
    const r = await same(db);
    expect(r.findings.missingColumns.products).toContain('itemType');
    expect(r.findings.missingTables).toContain('cash_sessions');
    // the child cannot start (a host that refuses a second node process): the fallback still judges, and says so
    const viaFallback = await checkCompanySchema(process.cwd(), dbCfg(db), ALL_TAGS, 'C:/definitely/not/node.exe', 60_000, true);
    expect(viaFallback.ran).toBe(true);
    expect(viaFallback.via).toBe('in_process');
    expect(viaFallback.findings.missingColumns.products).toContain('itemType');
    const noFallback = await checkCompanySchema(process.cwd(), dbCfg(db), ALL_TAGS, 'C:/definitely/not/node.exe', 60_000, false);
    expect(noFallback.ran).toBe(false);
    expect(noFallback.error).toContain('could not be started (ENOENT)');
  });

  it('a Company database that cannot be reached => ran:false, never clean, and the message carries no password', async () => {
    const r = await checkCompanySchema(process.cwd(), { ...dbCfg(`${PREFIX}_does_not_exist`), password: PASSWORD }, ['core'], process.execPath, 120_000);
    expect(r.ran).toBe(false);
    expect(r.error).toBeTruthy();
    if (PASSWORD) expect(r.error).not.toContain(PASSWORD);
  });
});
