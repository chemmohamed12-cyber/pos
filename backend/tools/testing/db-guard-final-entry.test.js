'use strict';
// node --test tools/testing/db-guard-final-entry.test.js — judges the SHIPPED approval entry (the dedicated 5546 cluster) with the real guard.
// (The earlier 5544 proposal/diff is SUPERSEDED and kept only as a fixture/record.) No database, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const guard = require('./db-guard');

const BACKEND = path.join(__dirname, '..', '..');
const T = (database, port = 5546, host = '127.0.0.1') => ({ host, port, database });
const facts = JSON.parse(fs.readFileSync(path.join(BACKEND, 'docs', 'decisions', 'evidence-2026-10-12-biz-cluster-rebuild', 'cluster-facts.json'), 'utf8')); // current cluster (rebuilt 2026-10-12)

test('exactly two approved entries (dedicated 5546 cluster; CTO-approved 5544 h3reg instance, 2026-10-26): complete, real approver text, valid date, no role patterns, postgres administrative-only', () => {
  const p = guard.loadPolicy();
  assert.deepEqual(p.approved.map((a) => a.port).sort(), [5544, 5546]);
  assert.equal(p.incomplete, 0);
  for (const x of p.approved) {
    assert.equal(x.host, '127.0.0.1');
    assert.doesNotMatch(x.approvedBy, /<|>|TBD|TODO/i);
    assert.match(x.approvedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(x.rolePatterns, []);
    assert.deepEqual(x.databases, []);
    assert.deepEqual(x.adminDatabases, ['postgres']);
  }
  const h = p.approved.find((a) => a.port === 5544);
  assert.deepEqual(h.databasePatterns, ['^daii_test_h3reg_[a-z0-9_]*$']);
  const e = p.approved.find((a) => a.port === 5546);
  assert.equal(e.port, 5546);
  assert.equal(e.host, '127.0.0.1');
  assert.doesNotMatch(e.approvedBy, /<|>|TBD|TODO/i);
  assert.match(e.approvedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(e.rolePatterns, []);
  assert.deepEqual(e.databases, []);
  assert.deepEqual(e.adminDatabases, ['postgres']);
  assert.deepEqual(e.databasePatterns, ['^daii_test_biz_t[0-9]{2}[a-z0-9_]*$']);
});

test('the pinned system_identifier equals the one recorded when the dedicated cluster was created; the cluster is loopback+scram only; the test role is least-privilege', () => {
  const e = guard.loadPolicy().approved[0];
  assert.equal(e.expectedSystemIdentifier, facts.systemIdentifier);
  assert.equal(facts.settings.listen_addresses, '127.0.0.1');
  assert.equal(String(facts.settings.port), '5546');
  for (const r of facts.hba) { assert.equal(r.auth_method, 'scram-sha-256'); assert.ok(['127.0.0.1', '::1'].includes(r.address)); }
  const role = facts.roles.find((r) => r.rolname === 'daii_biz_test');
  assert.equal(role.rolsuper, false); assert.equal(role.rolcreaterole, false); assert.equal(role.rolreplication, false); assert.equal(role.rolbypassrls, false);
  assert.equal(role.rolcreatedb, true); assert.equal(role.rolcanlogin, true);
  assert.equal(facts.testRoleCanExecuteControlSystem, true);
  assert.ok(facts.dataDirectory.includes('.test-cluster'), 'the data directory lives inside the project root, outside git');
});

test('semantics: postgres is administrative-only; business targets are t00…t12 disposable names only; everything protected stays blocked; other ports blocked', () => {
  const p = guard.loadPolicy();
  assert.equal(guard.evaluate(T('postgres'), p).role, 'admin');
  assert.equal(guard.evaluate(T('postgres'), p, { businessOnly: true }).allowed, false);
  assert.throws(() => guard.preflight({ env: { DB_HOST: '127.0.0.1', DB_PORT: '5546', DB_NAME: 'postgres' }, dotenv: {}, policy: p }), /administrative database/);
  assert.equal(guard.preflight({ env: { DB_HOST: '127.0.0.1', DB_PORT: '5546', DB_NAME: 'daii_test_biz_t00_unused' }, dotenv: {}, policy: p }).decision.role, 'business');
  for (let i = 0; i <= 12; i += 1) for (const s of ['', '_control_plane', '_company_a', '_company_b']) assert.equal(guard.evaluate(T(`daii_test_biz_t${String(i).padStart(2, '0')}${s}`), p).role, 'business');
  for (const bad of ['daii_test_ambient', 'daii_test_fanout_ambient', 'daii_test_h3_ambient', 'daii_dev', 'daii', 'restore_old_daii_dev', 'restore_quiet_daii_dev', 'restore_company_x', 'template0', 'template1', 'pool_b_663466', 'company_abc', 'daii_test_x']) {
    assert.equal(guard.evaluate(T(bad), p).allowed, false, bad);
  }
  for (const [db, port, host] of [['daii_test_biz_t01', 5433], ['daii_test_biz_t01', 5544], ['daii_test_biz_t01', 5656], ['postgres', 5433], ['postgres', 5656], ['daii_test_biz_t01', 5546, 'db.example.com'], ['daii_dev', 5544], ['restore_x', 5544], ['daii_test_h3reg_ambient', 5544], ['daii_test_h3reg_x', 5546], ['daii_test_h3reg_x', 5433]]) {
    assert.equal(guard.evaluate(T(db, port, host || '127.0.0.1'), p).allowed, false, `${host || '127.0.0.1'}:${port}/${db}`);
  }
  // the approved 5544 instance: loopback, daii_test_h3reg_* business names only, postgres administrative-only
  assert.equal(guard.evaluate(T('daii_test_h3reg_run', 5544), p).role, 'business');
  assert.equal(guard.evaluate(T('postgres', 5544), p).role, 'admin');
  assert.equal(guard.evaluate(T('postgres', 5544), p, { businessOnly: true }).allowed, false);
  assert.equal(guard.evaluate(T('daii_test_h3reg_run', 5544, 'db.example.com'), p).allowed, false);
});

test('statements: administrative connections create/drop only disposable names and never do business work; no role operations', () => {
  const p = guard.loadPolicy();
  const admin = (sql) => guard.checkAdminStatement(sql, T('postgres'), p) || guard.checkStatement(sql, T('postgres'), p);
  assert.equal(admin('CREATE DATABASE "daii_test_biz_t05_company_a"'), null);
  assert.equal(admin('DROP DATABASE IF EXISTS "daii_test_biz_t05_company_a" WITH (FORCE)'), null);
  for (const sql of ['DROP DATABASE "restore_old_daii_dev"', 'DROP DATABASE "daii_test_ambient"', 'DROP DATABASE "daii_dev"', 'DROP DATABASE "postgres"', 'CREATE DATABASE "daii_test_biz_t05" TEMPLATE "daii_dev"',
    'INSERT INTO t VALUES (1)', 'CREATE TABLE t (id int)', 'CREATE ROLE x', 'ALTER ROLE daii_biz_test SUPERUSER', 'DROP ROLE daii_biz_test', "ALTER SYSTEM SET fsync='on'"]) assert.ok(admin(sql), sql);
});

test('no credential value is in the policy file, the cluster facts, or the provisioning tool (checked against the live User-scope variables when available)', () => {
  const files = [path.join(BACKEND, 'tools', 'testing', 'approved-test-databases.json'), path.join(BACKEND, 'docs', 'decisions', 'evidence-2026-10-10-biz-cluster', 'cluster-facts.json'), path.join(BACKEND, 'docs', 'decisions', 'evidence-2026-10-12-biz-cluster-rebuild', 'cluster-facts.json'), path.join(BACKEND, 'tools', 'testing', 'biz-cluster-setup.js')];
  const secrets = [process.env.DAII_BIZ_PG_PASSWORD, process.env.DAII_BIZ_PG_BOOTSTRAP_PASSWORD].filter((s) => s && s.length >= 8);
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    for (const s of secrets) assert.equal(t.includes(s), false, `${path.basename(f)} contains a credential`);
    assert.doesNotMatch(t, /isolated_only_pw|daii_dev_only/);
  }
});
