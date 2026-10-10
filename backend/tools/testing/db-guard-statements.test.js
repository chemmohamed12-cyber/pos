'use strict';
// node --test tools/testing/db-guard-statements.test.js — statement-level guard; no database, no network (pg.Client is a fake).
const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('./db-guard');

const entry = {
  id: 'e', host: '127.0.0.1', port: 6001, databases: ['postgres', 'daii_test_ambient'], databasePatterns: ['^daii_test_biz_[a-z0-9_]+$'],
  rolePatterns: ['^daii_test_role_'], approvedBy: 'cto', approvedOn: 'x', identityEvidence: 'fixture',
};
const policy = { approved: [entry], incomplete: 0 };
const conn = { host: '127.0.0.1', port: 6001, database: 'postgres' };
const bad = (sql) => guard.checkStatement(sql, conn, policy);

test('disposable databases matching the approved pattern may be created and dropped', () => {
  assert.equal(bad('CREATE DATABASE "daii_test_biz_a1"'), null);
  assert.equal(bad('DROP DATABASE IF EXISTS "daii_test_biz_a1" WITH (FORCE)'), null);
  assert.equal(bad('drop database daii_test_biz_a1'), null);
});

test('everything else is refused: other names, ambient, maintenance, dev, restore copies, production-like', () => {
  for (const name of ['postgres', 'template1', 'daii_test_ambient', 'daii_dev', 'restore_old_daii_dev', 'restore_quiet_daii_dev', 'daii_test_biz_x_prod', 'pool_b_1', 'company_abc']) {
    assert.match(bad(`DROP DATABASE IF EXISTS "${name}"`) || '', /not allowed/, name);
    assert.match(bad(`CREATE DATABASE "${name}"`) || '', /not allowed/, name);
  }
  assert.match(bad('ALTER DATABASE "daii_test_ambient" RENAME TO x') || '', /not allowed/);
  assert.match(bad('ALTER DATABASE "restore_old_daii_dev" SET search_path = x') || '', /not allowed/);
});

test('quoting / comment / case tricks do not hide a statement', () => {
  assert.match(bad('/* x */ DROP   DATABASE\n"restore_old_daii_dev"') || '', /not allowed/);
  assert.match(bad('select 1; -- harmless\nDROP DATABASE "daii_dev"') || '', /not allowed/);
  assert.match(bad('DrOp DaTaBaSe "restore_quiet_daii_dev"') || '', /not allowed/);
  assert.match(bad('CREATE DATABASE "daii_test_biz_ok"; DROP DATABASE "daii_dev"') || '', /not allowed/);
});

test('role DDL requires a matching rolePatterns entry; ALTER SYSTEM and tablespaces are never allowed', () => {
  assert.equal(bad('CREATE ROLE "daii_test_role_1" LOGIN'), null);
  assert.match(bad('CREATE ROLE evil SUPERUSER') || '', /ROLE "evil" is not allowed/);
  assert.match(bad('DROP ROLE daii') || '', /not allowed/);
  assert.match(bad("ALTER SYSTEM SET fsync = 'on'") || '', /ALTER SYSTEM/);
  assert.match(bad('CREATE TABLESPACE t LOCATION \'x\'') || '', /tablespace/i);
  assert.match(bad('DROP OWNED BY daii') || '', /DROP OWNED/i);
  const noRoles = { approved: [{ ...entry, rolePatterns: undefined }], incomplete: 0 };
  assert.match(guard.checkStatement('CREATE ROLE "daii_test_role_1"', conn, noRoles) || '', /not allowed/);
});

test('pg_terminate_backend is only allowed with datname + application_name filters and its own pid excluded', () => {
  const ok = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'daii_test_biz_a1' AND application_name = 'run-42' AND pid <> pg_backend_pid()";
  assert.equal(bad(ok), null);
  assert.match(bad('SELECT pg_terminate_backend(pid) FROM pg_stat_activity') || '', /must filter/);
  assert.match(bad("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'x'") || '', /must filter/);
  assert.match(bad("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = 'x'") || '', /must filter/);
});

test('ordinary data statements are not affected (including words that merely contain create/drop)', () => {
  for (const sql of ['SELECT 1', 'INSERT INTO t(a) VALUES (1)', 'UPDATE t SET a = 2', 'SELECT rolcreatedb, rolname FROM pg_roles', 'CREATE TABLE x (id int)', 'DROP TABLE x', 'CREATE INDEX i ON x(id)']) assert.equal(bad(sql), null, sql);
});

test('statements on a server that is not approved are not judged here (the connection itself is refused by connect())', () => {
  assert.equal(guard.checkStatement('DROP DATABASE foo', { host: '127.0.0.1', port: 9999, database: 'postgres' }, policy), null);
});

test('installed on pg.Client.query: a refused statement never reaches the underlying query (promise and callback styles)', async () => {
  let reached = 0;
  class FakeClient {
    constructor(p) { this.connectionParameters = p; }
    connect() { return Promise.resolve(); }
    query() { reached += 1; return Promise.resolve({ rows: [] }); }
  }
  guard.install({ pg: { Client: FakeClient }, policy });
  const c = new FakeClient(conn);
  await assert.rejects(() => c.query('DROP DATABASE "restore_old_daii_dev"'), /REFUSED statement/);
  await assert.rejects(() => c.query({ text: 'DROP DATABASE "daii_dev"' }), /REFUSED statement/);
  await new Promise((resolve) => c.query('DROP DATABASE "daii_test_ambient"', (err) => { assert.match(err.message, /Nothing was executed/); resolve(); }));
  assert.equal(reached, 0);
  await c.query('CREATE DATABASE "daii_test_biz_z"');
  await c.query('SELECT 1');
  assert.equal(reached, 2);
});
