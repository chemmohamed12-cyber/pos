import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { runMigrationsForDatabase } from '../release-orchestration/company-migration-runner';
import { discoverMigrationTags } from '../release/migration-datasource';
import { CompanySchemaAdmission, CompanySchemaBehindException } from './company-schema-admission';

/**
 * Company schema admission against REAL PostgreSQL and the REAL compiled migrations (needs `npm run build`): a Company migrated by every migration of the build is admitted;
 * the same Company with the newest migrations missing from its history (the state the 1.1.10 / 1.1.11 upgrades left on the host) is refused with 503 COMPANY_SCHEMA_BEHIND,
 * and service resumes as soon as the history is complete again. Disposable databases `daii_test_<ns>sa_*`, isolated instance only.
 */
const HOST = process.env.DB_HOST ?? '127.0.0.1';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 0;
const USERNAME = process.env.DB_USER ?? '';
const PASSWORD = process.env.DB_PASSWORD ?? '';
const NS = process.env.DAII_TEST_DB_NS ?? '';
const PREFIX = `daii_test_${NS}sa_${randomUUID().slice(0, 8)}`;
const describeIsolated = PORT && PORT !== 5433 && USERNAME ? describe : describe.skip;

describeIsolated('Company schema admission - real Postgres, real compiled migrations', () => {
  jest.setTimeout(600_000);
  const cfg = (database: string) => ({ host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database });
  const made: string[] = [];
  let ds: DataSource;
  let clock = 5_000_000;
  const admission = new CompanySchemaAdmission();
  admission.overrides = { now: () => clock, mode: 'enforce' }; // shipped = the real compiled build under cwd

  beforeAll(async () => {
    const admin = new DataSource({ type: 'postgres', ...cfg('postgres'), synchronize: false, logging: false });
    await admin.initialize();
    const db = `${PREFIX}_co`;
    await admin.query(`CREATE DATABASE "${db}"`);
    made.push(db);
    await admin.destroy();
    const r = await runMigrationsForDatabase(process.cwd(), cfg(db), discoverMigrationTags(process.cwd()));
    if (!r.success) throw new Error(`fixture migration failed: ${r.error}`);
    ds = new DataSource({ type: 'postgres', ...cfg(db), synchronize: false, logging: false });
    await ds.initialize();
  });
  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    const admin = new DataSource({ type: 'postgres', ...cfg('postgres'), synchronize: false, logging: false });
    await admin.initialize();
    for (const db of made) await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    await admin.destroy();
  });

  it('a Company migrated by every migration of the build is ADMITTED', async () => {
    await expect(admission.assertCurrent('co', ds)).resolves.toBeUndefined();
  });

  it('with the newest migrations missing from its history (the host state) it is REFUSED with 503 COMPANY_SCHEMA_BEHIND; with the history complete again, service resumes', async () => {
    const newest: Array<{ id: number; timestamp: string; name: string }> = await ds.query(`SELECT id, timestamp::text AS timestamp, name FROM migrations ORDER BY timestamp DESC, id DESC LIMIT 5`);
    expect(newest).toHaveLength(5);
    await ds.query(`DELETE FROM migrations WHERE id = ANY($1::int[])`, [newest.map((n) => n.id)]);
    clock += 60_000; // past any cached verdict
    const err = await admission.assertCurrent('co', ds).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CompanySchemaBehindException);
    expect((err as CompanySchemaBehindException).getStatus()).toBe(503);

    for (const n of newest.reverse()) await ds.query(`INSERT INTO migrations (timestamp, name) VALUES ($1, $2)`, [n.timestamp, n.name]);
    clock += 6_000; // past the short refusal TTL
    await expect(admission.assertCurrent('co', ds)).resolves.toBeUndefined();
  });

  it('the check is READ-ONLY (it never writes to the Company database)', async () => {
    const before: Array<{ n: string }> = await ds.query(`SELECT count(*)::text n FROM migrations`);
    clock += 60_000;
    await admission.assertCurrent('co', ds);
    const after: Array<{ n: string }> = await ds.query(`SELECT count(*)::text n FROM migrations`);
    expect(after[0].n).toBe(before[0].n);
  });
});
