'use strict';
/**
 * Hypothesis test for the disposable-database teardown race ("permission denied to terminate process" on DROP DATABASE ... WITH (FORCE)):
 *   H-AV: the failure happens when a background process owned by another (superuser) role — an autovacuum worker — is connected to the database at drop time,
 *         because a non-superuser may not terminate it.
 * Method (dedicated test cluster only, approved-pattern database name, role daii_biz_test, nothing else touched): create one disposable database, give it a table
 * with many dead tuples so autovacuum selects it, then poll pg_stat_progress_vacuum (visible to every role) for that database and, the moment a vacuum worker is
 * reported, issue DROP DATABASE ... WITH (FORCE) exactly as the test harness does. Record the error code/message/detail or the success, the worker evidence and
 * the cluster's autovacuum settings. Usage: PGPW=<password> node autovacuum_drop_probe.js <dbname> > result.json
 */
const path = require('path');
const { Client } = require(path.resolve(__dirname, '..', '..', '..', 'node_modules', 'pg'));
const DB = process.argv[2];
if (!/^daii_test_biz_t9[0-9]_[a-z0-9_]+$/.test(DB || '')) { console.error('REFUSED: database name must match daii_test_biz_t9N_*'); process.exit(2); }
const cfg = (database) => ({ host: '127.0.0.1', port: 5546, user: 'daii_biz_test', password: process.env.PGPW, database });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const out = { database: DB, startedAt: new Date().toISOString() };
  const admin = new Client(cfg('postgres')); await admin.connect();
  out.cluster = { server: (await admin.query('SHOW server_version')).rows[0].server_version, autovacuum: (await admin.query('SHOW autovacuum')).rows[0].autovacuum, naptime: (await admin.query('SHOW autovacuum_naptime')).rows[0].autovacuum_naptime, systemIdentifier: (await admin.query('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s };
  await admin.query(`CREATE DATABASE "${DB}"`);
  const w = new Client(cfg(DB)); await w.connect();
  await w.query('CREATE TABLE t (id int primary key, v int, pad text)');
  await w.query("INSERT INTO t SELECT g, g, repeat('x', 100) FROM generate_series(1, 1500000) g");
  await w.query('UPDATE t SET v = v + 1');
  await w.query('UPDATE t SET v = v + 1');
  await w.end(); // no client session of ours remains in the database
  out.preparedAt = new Date().toISOString();
  const deadline = Date.now() + 240000;
  let sawWorker = null;
  while (Date.now() < deadline) {
    const r = await admin.query('SELECT pid, datname, relid::regclass::text AS rel, phase FROM pg_stat_progress_vacuum WHERE datname = $1', [DB]);
    if (r.rows.length) { sawWorker = r.rows[0]; break; }
    await sleep(150);
  }
  out.vacuumWorkerSeenAtDropTime = sawWorker;
  out.dropIssuedAt = new Date().toISOString();
  try {
    await admin.query(`DROP DATABASE "${DB}" WITH (FORCE)`);
    out.drop = { outcome: 'dropped-first-attempt' };
  } catch (e) {
    out.drop = { outcome: 'error', code: e.code, message: e.message, detail: e.detail, hint: e.hint };
    for (let i = 1; i <= 8; i += 1) {
      await sleep(250 * i);
      try { await admin.query(`DROP DATABASE "${DB}" WITH (FORCE)`); out.drop.laterSuccess = { afterAttempts: i + 1, waitedMs: 250 * ((i * (i + 1)) / 2) }; break; } catch (e2) { out.drop.lastError = { code: e2.code, message: e2.message }; }
    }
  }
  const left = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB]);
  out.databaseStillExists = left.rows.length > 0;
  if (out.databaseStillExists) { try { await admin.query(`DROP DATABASE "${DB}" WITH (FORCE)`); out.cleanup = 'dropped'; } catch (e) { out.cleanup = `FAILED: ${e.message}`; } }
  await admin.end();
  out.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.log(JSON.stringify({ fatal: e.message })); process.exit(1); });
