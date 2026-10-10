'use strict';
/**
 * READ-ONLY database identity / cleanliness inspector (CTO decision D-2, 2026-10-10).
 *
 *   node tools/testing/db-identity-inspect.js --port 5544 --db postgres [--db daii_test_ambient] [--out backend/docs/decisions/evidence-2026-10-10-d2]
 *
 * Guarantees (enforced in code, not by convention):
 *  - runs under the DB guard with a SCOPED in-process policy: only 127.0.0.1:5544 and only the databases passed with --db, and only
 *    from the allow-list below. This is an inspection scope, NOT a test-database approval; nothing is written to approved-test-databases.json.
 *  - every statement is a SELECT/SHOW inside BEGIN READ ONLY (session also has default_transaction_read_only=on); no DDL, no writes;
 *  - output is written ONLY inside the approved project root, with a SHA-256 file;
 *  - aggregates only (counts, ranges, e-mail DOMAINS): no row contents, no credentials, no personal data are recorded.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const guard = require('./db-guard');
const proc = require('./db-guard-process');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // .../release-new
const ALLOWED_PORT = 5544;
const ALLOWED_DBS = new Set(['postgres']); // maintenance database only (administrative, read-only). daii_test_ambient is hard-denied by the guard since 2026-10-10; its inspection evidence is already recorded.
const USER = 'isolated_admin';
const PASSWORD = process.env.ISOLATED_PG_PASSWORD || 'isolated_only_pw'; // the project's own isolated-test credential (provision-isolated-ambient-db.js)

function arg(name, all = false) {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === `--${name}`) out.push(process.argv[i + 1]);
  return all ? out : out[0];
}

const port = Number(arg('port'));
const dbs = arg('db', true);
const outDir = path.resolve(arg('out') || path.join(ROOT, 'backend', 'docs', 'decisions', 'evidence-2026-10-10-d2'));
if (port !== ALLOWED_PORT) die(`port ${port} is not in the authorised set (only ${ALLOWED_PORT})`);
if (!dbs.length || dbs.some((d) => !ALLOWED_DBS.has(d))) die(`databases must be a non-empty subset of: ${[...ALLOWED_DBS].join(', ')}`);
if (!(outDir + path.sep).startsWith(ROOT + path.sep)) die(`output directory must be inside the approved project root (${ROOT})`);

const scoped = {
  approved: [{
    id: 'inspection-scope-only', host: '127.0.0.1', port: ALLOWED_PORT, adminDatabases: dbs,
    approvedBy: 'CTO D-2 conditional approval 2026-10-10 (READ-ONLY identity/cleanliness inspection; NOT a test-database approval)',
    approvedOn: '2026-10-10', identityEvidence: 'inspection tool scope',
  }],
  incomplete: 0,
};
proc.installAll({ policy: scoped, noEnv: true });
const { Client } = require('pg');

function die(m) { console.error('REFUSED: ' + m); process.exit(2); }

const SERVER = {
  identity: `SELECT version() AS version, current_user AS "user", inet_server_addr()::text AS server_addr, inet_server_port() AS server_port, pg_postmaster_start_time() AS postmaster_start, pg_is_in_recovery() AS in_recovery`,
  control: `SELECT system_identifier::text AS system_identifier FROM pg_control_system()`,
  settings: `SELECT name, setting FROM pg_settings WHERE name IN ('data_directory','listen_addresses','port','max_connections','fsync','ssl','wal_level') ORDER BY name`,
  sessions: `SELECT datname, usename, application_name, state FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() ORDER BY datname`,
};

const PER_DB = {
  identity: `SELECT current_database() AS database, pg_get_userbyid(d.datdba) AS owner, d.datistemplate, d.datallowconn, d.datconnlimit, pg_database_size(current_database()) AS size_bytes
             FROM pg_database d WHERE d.datname = current_database()`,
  stats: `SELECT numbackends, xact_commit, xact_rollback, stats_reset, tup_inserted, tup_updated, tup_deleted FROM pg_stat_database WHERE datname = current_database()`,
  extensions: `SELECT extname, extversion FROM pg_extension ORDER BY 1`,
  schemas: `SELECT nspname FROM pg_namespace WHERE nspname !~ '^(pg_|information_schema)' ORDER BY 1`,
  table_count: `SELECT count(*)::int AS tables FROM pg_stat_user_tables`,
  migrations: `SELECT to_regclass('public.migrations') IS NOT NULL AS has_table`,
};

async function exact(c) { // exact row counts for every user table (aggregates only)
  const t = (await c.query(`SELECT relname FROM pg_stat_user_tables ORDER BY relname`)).rows.map((r) => r.relname);
  const out = {};
  for (const name of t) {
    try { out[name] = Number((await c.query(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`)).rows[0].n); } catch (e) { out[name] = `error: ${e.message}`; }
  }
  return out;
}

async function inspectDb(db) {
  const c = new Client({ host: '127.0.0.1', port, database: db, user: USER, password: PASSWORD, options: '-c default_transaction_read_only=on -c statement_timeout=30000', connectionTimeoutMillis: 8000 });
  await c.connect();
  const r = { database: db };
  const run = async (k, sql) => { try { await c.query('BEGIN READ ONLY'); r[k] = (await c.query(sql)).rows; } catch (e) { r[k] = { error: e.message }; } finally { try { await c.query('ROLLBACK'); } catch (_) { /* aborted */ } } };
  if (db === 'postgres') {
    for (const [k, sql] of Object.entries(SERVER)) await run(k, sql);
    await run('databases', `SELECT d.datname, pg_get_userbyid(d.datdba) AS owner, d.datistemplate, d.datallowconn, d.datconnlimit, s.numbackends, s.stats_reset FROM pg_database d LEFT JOIN pg_stat_database s ON s.datid = d.oid ORDER BY 1`);
    await run('roles', `SELECT rolname, rolsuper, rolcreatedb, rolcanlogin, rolreplication FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1`);
    await run('hba', `SELECT line_number, type, database, user_name, address, auth_method FROM pg_hba_file_rules ORDER BY 1`);
  }
  for (const [k, sql] of Object.entries(PER_DB)) await run(k, sql);
  if (db !== 'postgres') {
    try { await c.query('BEGIN READ ONLY'); r.row_counts = await exact(c); } finally { try { await c.query('ROLLBACK'); } catch (_) { /* */ } }
    await run('migrations_applied', `SELECT count(*)::int AS applied, max(timestamp)::text AS latest_timestamp, (array_agg(name ORDER BY timestamp DESC))[1] AS latest_name FROM migrations`);
    await run('migration_timestamps', `SELECT timestamp::text AS ts, name FROM migrations ORDER BY timestamp`);
    await run('audit_range', `SELECT count(*)::int AS records, min("timestamp") AS first, max("timestamp") AS last FROM audit_records`);
    await run('user_email_domains', `SELECT split_part(email, '@', 2) AS domain, count(*)::int AS users FROM users GROUP BY 1 ORDER BY 2 DESC LIMIT 20`);
    await run('companies', `SELECT count(*)::int AS companies, count(*) FILTER (WHERE status <> 'READY')::int AS not_ready FROM companies`);
    await run('movement_signals', `SELECT count(*)::int AS stock_movements, count(DISTINCT "referenceType")::int AS reference_types, min("createdAt") AS first, max("createdAt") AS last FROM stock_movements`);
    await run('negative_onhand', `SELECT count(*)::int AS pairs_negative FROM (SELECT 1 FROM stock_movements GROUP BY "warehouseId","productId" HAVING SUM(quantity) < 0) x`);
    await run('journal_balance', `SELECT count(*)::int AS unbalanced_entries FROM (SELECT "journalEntryId" FROM accounting_journal_lines GROUP BY 1 HAVING SUM("debitBase") <> SUM("creditBase")) x`);
  }
  await c.end();
  return r;
}

(async () => {
  const result = { inspectedAt: new Date().toISOString(), target: { host: '127.0.0.1', port }, mode: 'READ ONLY (BEGIN READ ONLY; default_transaction_read_only=on); aggregates only; credentials not recorded', databases: {} };
  for (const db of dbs) result.databases[db] = await inspectDb(db);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `inspect-${port}-${dbs.join('+')}-${stamp}.json`);
  const body = JSON.stringify(result, null, 2);
  fs.writeFileSync(file, body);
  fs.writeFileSync(file + '.sha256', `${crypto.createHash('sha256').update(body).digest('hex')}  ${path.basename(file)}\n`);
  console.log('saved', path.relative(ROOT, file));
})().catch((e) => die('inspection failed: ' + e.message));
