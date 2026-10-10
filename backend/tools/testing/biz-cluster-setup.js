'use strict';
/**
 * Creates the DEDICATED local PostgreSQL cluster for the business-test program (CTO "Autonomous Testing & Verification" directive).
 *
 *   node tools/testing/biz-cluster-setup.js setup      # create + start + least-privilege test role + facts (no secrets)
 *   node tools/testing/biz-cluster-setup.js status     # is it running / identity facts (needs the bootstrap env var)
 *   node tools/testing/biz-cluster-setup.js stop|start # lifecycle of THIS cluster only
 *
 * Hard limits (enforced in code): loopback only; port 5546 only (never 5433/5544/5656); data directory INSIDE the approved project root and
 * outside git; passwords are generated here (crypto), handed to initdb/psql over STDIN or in-process memory, and persisted ONLY as Windows
 * User-scope environment variables (written through a PowerShell stdin pipe so the value never appears on a command line, in a file or in output).
 * The bootstrap superuser exists only to create the cluster and the least-privilege test role; tests use the test role.
 *
 * This is an environment-provisioning (operator) tool, not a test program: it is listed as an explicit operator-tool exclusion of the DB guard.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PORT = 5546;
const HOST = '127.0.0.1';
const BIN = 'C:\\Program Files\\PostgreSQL\\18\\bin';
const ROOT = path.resolve(__dirname, '..', '..', '..'); // release-new
const BASE = path.join(ROOT, '.test-cluster', `pg${PORT}`);
const DATA = path.join(BASE, 'data');
const LOG = path.join(BASE, 'server.log');
const BOOT_USER = 'daii_bootstrap';
const TEST_USER = 'daii_biz_test';
const EVIDENCE = path.join(ROOT, 'backend', 'docs', 'decisions', 'evidence-2026-10-10-biz-cluster');
const ENV_PW = 'DAII_BIZ_PG_PASSWORD';
const ENV_BOOT = 'DAII_BIZ_PG_BOOTSTRAP_PASSWORD';

function die(m) { console.error('REFUSED: ' + m); process.exit(2); }
if (![5433, 5544, 5656].every((p) => p !== PORT)) die('forbidden port');
if (!(DATA + path.sep).startsWith(ROOT + path.sep)) die('data directory must be inside the approved project root');

const exe = (n) => path.join(BIN, n);
const strong = () => crypto.randomBytes(24).toString('base64').replace(/[+/=]/g, 'x') + 'Aa1';

function userEnv(name) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`], { encoding: 'utf8' });
  return (r.stdout || '').trim() || undefined;
}
function setUserEnv(name, value) { // value over stdin: never on a command line
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `$v = [Console]::In.ReadToEnd().Trim(); [Environment]::SetEnvironmentVariable('${name}', $v, 'User')`], { input: value, encoding: 'utf8' });
  if (r.status !== 0) die(`could not persist ${name}`);
}

async function client(user, password, database = 'postgres') {
  const { Client } = require(path.join(ROOT, 'backend', 'node_modules', 'pg'));
  const c = new Client({ host: HOST, port: PORT, user, password, database, connectionTimeoutMillis: 8000 });
  await c.connect();
  return c;
}

function isUp() {
  return spawnSync(exe('pg_ctl.exe'), ['status', '-D', DATA], { encoding: 'utf8' }).status === 0;
}

function start() {
  if (isUp()) return;
  // stdio 'ignore': the server inherits pipes otherwise and spawnSync would wait for them forever
  const r = spawnSync(exe('pg_ctl.exe'), ['start', '-D', DATA, '-l', LOG, '-w', '-t', '60', '-o', `-p ${PORT}`], { stdio: 'ignore' });
  if (r.status !== 0) die('pg_ctl start failed (see server.log)');
}

async function facts(c) {
  const q = async (sql) => (await c.query(sql)).rows;
  return {
    version: (await q('SELECT version() AS v'))[0].v,
    systemIdentifier: (await q('SELECT system_identifier::text AS s FROM pg_control_system()'))[0].s,
    settings: Object.fromEntries((await q("SELECT name, setting FROM pg_settings WHERE name IN ('data_directory','listen_addresses','port','fsync','max_connections','password_encryption','hba_file')")).map((r) => [r.name, r.setting])),
    hba: (await q("SELECT type, database, user_name, address, auth_method FROM pg_hba_file_rules ORDER BY line_number")),
    roles: await q(`SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1`),
    databases: (await q('SELECT datname FROM pg_database ORDER BY 1')).map((r) => r.datname),
    testRoleCanExecuteControlSystem: (await q(`SELECT has_function_privilege('${TEST_USER}', 'pg_control_system()', 'EXECUTE') AS ok`))[0].ok,
  };
}

async function setup() {
  if (fs.existsSync(path.join(DATA, 'PG_VERSION'))) die(`a cluster already exists at ${DATA}; use "status"`);
  fs.mkdirSync(BASE, { recursive: true });
  const bootPw = strong();
  const testPw = strong();
  // initdb here cannot read a password from stdin, so the superuser is created WITHOUT a password under scram auth (it cannot log in) and its
  // password is then set in single-user mode over STDIN — before any server process exists, so there is never an unauthenticated listener.
  const init = spawnSync(exe('initdb.exe'), ['-D', DATA, '-U', BOOT_USER, '--auth-local=reject', '--auth-host=reject', '-E', 'UTF8', '--locale=C'], { encoding: 'utf8' });
  if (init.status !== 0) die('initdb failed: ' + String(init.stderr).slice(0, 300));
  const single = spawnSync(exe('postgres.exe'), ['--single', '-D', DATA, 'postgres'], { input: `ALTER ROLE ${BOOT_USER} PASSWORD '${bootPw}'\n`, encoding: 'utf8' });
  if (single.status !== 0) die('could not set the bootstrap password in single-user mode');
  // initdb created every rule as `reject`; the first server start happens only after this scram-only, loopback-only rule set is in place
  fs.writeFileSync(path.join(DATA, 'pg_hba.conf'), ['# DAII business-test cluster: loopback + scram-sha-256 only', 'host    all    all    127.0.0.1/32    scram-sha-256', 'host    all    all    ::1/128         scram-sha-256', ''].join('\n'));
  fs.appendFileSync(path.join(DATA, 'postgresql.conf'), `\n# DAII business-test cluster (dedicated, loopback only)\nlisten_addresses = '127.0.0.1'\nport = ${PORT}\nfsync = off\nmax_connections = 200\npassword_encryption = 'scram-sha-256'\nlog_connections = off\nlog_statement = 'none'\n`);
  start();
  const boot = await client(BOOT_USER, bootPw);
  // least-privilege role: login + CREATEDB only (to create/drop its own disposable databases); no superuser/createrole/replication/bypassrls
  await boot.query(`CREATE ROLE ${TEST_USER} LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${testPw.replace(/'/g, "''")}'`);
  await boot.query(`GRANT EXECUTE ON FUNCTION pg_control_system() TO ${TEST_USER}`); // read-only identity check (system_identifier)
  const f = await facts(boot);
  await boot.end();
  setUserEnv(ENV_PW, testPw);
  setUserEnv(ENV_BOOT, bootPw);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, 'cluster-facts.json'), JSON.stringify({ createdAt: new Date().toISOString(), host: HOST, port: PORT, dataDirectory: DATA, testRole: TEST_USER, bootstrapRole: BOOT_USER, passwordsPersistedAs: { testRole: `User env ${ENV_PW}`, bootstrap: `User env ${ENV_BOOT}` }, ...f }, null, 2));
  console.log(JSON.stringify({ port: PORT, systemIdentifier: f.systemIdentifier, testRole: f.roles.find((r) => r.rolname === TEST_USER), testRoleCanExecuteControlSystem: f.testRoleCanExecuteControlSystem }, null, 2));
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'setup') return setup();
  if (cmd === 'start') { start(); return console.log('started'); }
  if (cmd === 'stop') { spawnSync(exe('pg_ctl.exe'), ['stop', '-D', DATA, '-m', 'fast', '-w'], { stdio: 'inherit' }); return; }
  if (cmd === 'status') {
    const bootPw = userEnv(ENV_BOOT);
    console.log('running:', isUp());
    if (isUp() && bootPw) { const c = await client(BOOT_USER, bootPw); console.log(JSON.stringify(await facts(c), null, 2)); await c.end(); }
    return;
  }
  die('usage: setup | status | start | stop');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
