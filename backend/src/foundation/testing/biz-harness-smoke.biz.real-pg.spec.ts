import { readdirSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { setUpTwoCompanyHarness } from './two-company-real-pg-harness';

/* eslint-disable @typescript-eslint/no-var-requires */
const ev = require('../../../tools/testing/biz-evidence');
const guard = require('../../../tools/testing/db-guard');

/**
 * T-00 — harness smoke for the business-test program (run FIRST, only after the database approval entry is committed).
 * Proves, with evidence, the Phase-6 claims about the provisioning harness:
 *   1. every run starts from a FRESH database set — the three disposable databases do not exist before and are created by the run;
 *   2. they are migrated from the CURRENT migration set (applied timestamps == the repository's migration files for the tags used);
 *   3. evidence is written (and re-verified) OUTSIDE the databases BEFORE any cleanup;
 *   4. cleanup removes exactly those three databases and nothing else (the set of other databases is identical before and after);
 *   5. the instance is the approved one (system_identifier equals the approved entry's expectedSystemIdentifier) — STOP otherwise.
 * Environment: DB_HOST=127.0.0.1 DB_PORT=5544 DB_USER=isolated_admin DB_PASSWORD=<isolated test credential> DB_NAME=daii_test_biz_t00_unused
 */
const PREFIX = 'biz_t00';
const NAMES = ['control_plane', 'company_a', 'company_b'].map((s) => `daii_test_${PREFIX}_${s}`);
const EXTRA_TAGS = ['sales', 'inventory', 'finance', 'procurement', 'accounting'];

function repoTimestamps(tags: string[]): number[] {
  const out = new Set<number>();
  for (const tag of tags) {
    const dir = join(process.cwd(), 'src', 'database', 'migrations', tag);
    for (const f of readdirSync(dir)) {
      const m = /^(\d{13})-.+\.ts$/.exec(f);
      if (m && !f.endsWith('.spec.ts')) out.add(Number(m[1]));
    }
  }
  return [...out].sort((a, b) => a - b);
}

async function adminDs(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'postgres',
    synchronize: false,
    logging: false,
  });
  await ds.initialize();
  return ds;
}

describe('T-00 harness smoke — fresh disposable databases from the current migration set', () => {
  jest.setTimeout(900_000);

  it('creates fresh databases, migrates to the current set, preserves evidence, then removes exactly those databases', async () => {
    const run = ev.createRun('T-00');
    const policyEntry = guard.loadPolicy().approved[0];
    expect(policyEntry).toBeTruthy();

    // ---- before: identity + inventory of the instance (read-only on the administrative connection) ----
    const adminBefore = await adminDs();
    const systemIdentifier: string = await ev.readSystemIdentifier(adminBefore);
    const before: Array<{ datname: string; oid: string }> = await adminBefore.query('SELECT datname, oid::text AS oid FROM pg_database ORDER BY datname');
    await adminBefore.destroy();
    if (systemIdentifier !== policyEntry.expectedSystemIdentifier) {
      ev.writeHeader(run, { systemIdentifier, expectedSystemIdentifier: policyEntry.expectedSystemIdentifier });
      ev.writeResult(run, [{ id: 'identity', status: 'STOP', note: 'system_identifier differs from the approved entry' }]);
      ev.finalize(run);
      throw new Error(`STOP: unexpected PostgreSQL system_identifier ${systemIdentifier}`);
    }
    for (const n of NAMES) expect(before.map((d) => d.datname)).not.toContain(n); // fresh: none exist yet

    let h: Awaited<ReturnType<typeof setUpTwoCompanyHarness>> | undefined;
    try {
      h = await setUpTwoCompanyHarness({ namePrefix: PREFIX, extraCompanyTags: EXTRA_TAGS });

      // ---- during: created + migrated to the CURRENT set ----
      const adminMid = await adminDs();
      const mid: Array<{ datname: string; oid: string }> = await adminMid.query('SELECT datname, oid::text AS oid FROM pg_database ORDER BY datname');
      await adminMid.destroy();
      for (const n of NAMES) expect(mid.map((d) => d.datname)).toContain(n);
      const cpApplied: Array<{ timestamp: string }> = await h.controlPlane.query('SELECT timestamp::text AS timestamp FROM migrations');
      const dsA = await h.connections.getDataSource(h.companyAId);
      const aApplied: Array<{ timestamp: string }> = await dsA.query('SELECT timestamp::text AS timestamp FROM migrations');
      const asSet = (rows: Array<{ timestamp: string }>) => [...new Set(rows.map((r) => Number(r.timestamp)))].sort((a, b) => a - b);
      const cpExpected = repoTimestamps(['core']);
      const aExpected = repoTimestamps(['core', ...EXTRA_TAGS]);

      ev.writeHeader(run, { systemIdentifier, databases: NAMES, prefix: PREFIX, tags: { controlPlane: ['core'], company: ['core', ...EXTRA_TAGS] } });
      ev.writeJson(run, 'databases-before.json', before);
      ev.writeJson(run, 'databases-during.json', mid);
      ev.writeJson(run, 'migrations-compare.json', {
        controlPlane: { applied: asSet(cpApplied).length, expected: cpExpected.length, latestApplied: asSet(cpApplied).slice(-1)[0], latestExpected: cpExpected.slice(-1)[0] },
        companyA: { applied: asSet(aApplied).length, expected: aExpected.length, latestApplied: asSet(aApplied).slice(-1)[0], latestExpected: aExpected.slice(-1)[0] },
      });
      expect(asSet(cpApplied)).toEqual(cpExpected);
      expect(asSet(aApplied)).toEqual(aExpected);
      const dsB = await h.connections.getDataSource(h.companyBId);
      expect(asSet(await dsB.query('SELECT timestamp::text AS timestamp FROM migrations'))).toEqual(aExpected);

      // ---- evidence BEFORE cleanup: written, re-read and hash-verified (throws => cleanup still runs in finally, results say STOP) ----
      ev.writeResult(run, [{ id: 'fresh-from-current-migrations', status: 'PASS' }]);
      ev.finalize(run);
    } finally {
      if (h) await h.teardown();
    }

    // ---- after: exactly the three disposable databases are gone; every other database is untouched ----
    const adminAfter = await adminDs();
    const after: Array<{ datname: string; oid: string }> = await adminAfter.query('SELECT datname, oid::text AS oid FROM pg_database ORDER BY datname');
    await adminAfter.destroy();
    for (const n of NAMES) expect(after.map((d) => d.datname)).not.toContain(n);
    expect(after).toEqual(before); // same names AND same oids: nothing else was created, dropped or recreated
    ev.writeJson(run, 'databases-after.json', after);
    ev.writeJson(run, 'post-cleanup.json', { removed: NAMES, otherDatabasesUnchanged: true });
    ev.finalize(run);
  });
});
