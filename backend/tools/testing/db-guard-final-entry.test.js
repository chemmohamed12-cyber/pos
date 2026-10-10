'use strict';
// node --test tools/testing/db-guard-final-entry.test.js
// Verifies the FINAL approval-entry diff (docs/decisions/test-program/APPROVAL-ENTRY-FINAL.diff) WITHOUT applying it: the post-diff policy is
// reconstructed in a scratch file inside the project root (removed afterwards) and judged by the real guard. No database, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const guard = require('./db-guard');
const ev = require('./biz-evidence');

const BACKEND = path.join(__dirname, '..', '..');
const DIFF = fs.readFileSync(path.join(BACKEND, 'docs', 'decisions', 'test-program', 'APPROVAL-ENTRY-FINAL.diff'), 'utf8');
const CURRENT = fs.readFileSync(path.join(BACKEND, 'tools', 'testing', 'approved-test-databases.json'), 'utf8');
const SELF = path.join(ev.EVIDENCE_BASE, '_selftest-final-entry'); // own scratch dir: node --test runs files in parallel
test.after(() => fs.rmSync(SELF, { recursive: true, force: true }));

function reconstruct() {
  const lines = DIFF.split(/\r?\n/);
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1));
  return { added, removed, text: CURRENT.replace('  "approved": [],', added.join('\n')) };
}

function finalPolicy() {
  const { text } = reconstruct();
  fs.mkdirSync(SELF, { recursive: true });
  const f = path.join(SELF, 'final-approved.json');
  fs.writeFileSync(f, text);
  return guard.loadPolicy(f);
}
const T = (database, port = 5544, host = '127.0.0.1') => ({ host, port, database });

test('the diff touches exactly one file and exactly one removed line (the empty list); the approval list in the repo is still empty', () => {
  const files = DIFF.split(/\r?\n/).filter((l) => l.startsWith('diff --git'));
  assert.deepEqual(files, ['diff --git a/backend/tools/testing/approved-test-databases.json b/backend/tools/testing/approved-test-databases.json']);
  assert.deepEqual(reconstruct().removed, ['  "approved": [],']);
  assert.equal(guard.loadPolicy().approved.length, 0, 'NOT applied: the shipped approval list approves nothing');
});

test('the post-diff entry is complete (real approver identity, valid date, evidence), the file stays valid JSON, and it is the only approved entry', () => {
  const { text } = reconstruct();
  const parsed = JSON.parse(text);
  assert.equal(parsed.approved.length, 1);
  const e = parsed.approved[0];
  assert.doesNotMatch(e.approvedBy, /<|>|TBD|TODO/i);
  assert.match(e.approvedOn, /^\d{4}-\d{2}-\d{2}$/);
  const p = finalPolicy();
  assert.equal(p.approved.length, 1, 'the guard accepts the entry as complete');
  assert.equal(p.incomplete, 0);
  assert.deepEqual(e.rolePatterns, []);
  assert.deepEqual(e.databases, []);
  assert.deepEqual(e.adminDatabases, ['postgres']);
  assert.deepEqual(e.databasePatterns, ['^daii_test_biz_t[0-9]{2}[a-z0-9_]*$']);
});

test('the pinned system_identifier equals the identifier recorded in the D-2 evidence', () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(BACKEND, 'docs', 'decisions', 'evidence-2026-10-10-d2', 'port-5544-identity.json'), 'utf8'));
  const id = (evidence.control && evidence.control[0] && evidence.control[0].system_identifier) || null;
  assert.equal(id, JSON.parse(reconstruct().text).approved[0].expectedSystemIdentifier);
});

test('post-diff semantics: postgres is administrative-only; business only on fresh disposable names; everything excluded stays blocked', () => {
  const p = finalPolicy();
  assert.equal(guard.evaluate(T('postgres'), p).role, 'admin');
  assert.equal(guard.evaluate(T('postgres'), p, { businessOnly: true }).allowed, false);
  assert.throws(() => guard.preflight({ env: { DB_HOST: '127.0.0.1', DB_PORT: '5544', DB_NAME: 'postgres' }, dotenv: {}, policy: p }), /administrative database/);
  assert.equal(guard.preflight({ env: { DB_HOST: '127.0.0.1', DB_PORT: '5544', DB_NAME: 'daii_test_biz_t00_unused' }, dotenv: {}, policy: p }).decision.role, 'business');
  for (let i = 0; i <= 12; i += 1) for (const s of ['', '_control_plane', '_company_a', '_company_b']) assert.equal(guard.evaluate(T(`daii_test_biz_t${String(i).padStart(2, '0')}${s}`), p).role, 'business');
  for (const bad of ['daii_test_ambient', 'daii_test_fanout_ambient', 'daii_test_h3_ambient', 'daii_dev', 'daii', 'restore_old_daii_dev', 'restore_quiet_daii_dev', 'restore_company_x', 'template0', 'template1', 'pool_b_663466', 'rehearsal_fresh', 'company_abc', 'daii_test_x']) {
    assert.equal(guard.evaluate(T(bad), p).allowed, false, bad);
  }
  for (const [db, port, host] of [['daii_test_biz_t01', 5433, '127.0.0.1'], ['daii_test_biz_t01', 5656, '127.0.0.1'], ['daii_test_biz_t01', 5544, 'db.example.com'], ['postgres', 5433, '127.0.0.1'], ['postgres', 5656, '127.0.0.1']]) {
    assert.equal(guard.evaluate(T(db, port, host), p).allowed, false, `${host}:${port}/${db}`);
  }
});

test('post-diff statements: administrative connections create/drop only disposable names and never do business work; no role operations', () => {
  const p = finalPolicy();
  const admin = (sql) => guard.checkAdminStatement(sql, T('postgres'), p) || guard.checkStatement(sql, T('postgres'), p);
  assert.equal(admin('CREATE DATABASE "daii_test_biz_t05_company_a"'), null);
  assert.equal(admin('DROP DATABASE IF EXISTS "daii_test_biz_t05_company_a" WITH (FORCE)'), null);
  for (const sql of ['DROP DATABASE "restore_old_daii_dev"', 'DROP DATABASE "restore_quiet_daii_dev"', 'DROP DATABASE "daii_test_ambient"', 'DROP DATABASE "daii_dev"', 'CREATE DATABASE "daii_test_biz_t05" TEMPLATE "daii_dev"',
    'INSERT INTO t VALUES (1)', 'CREATE TABLE t (id int)', 'CREATE ROLE x', 'ALTER ROLE daii SUPERUSER', 'DROP ROLE daii', "ALTER SYSTEM SET fsync='on'"]) assert.ok(admin(sql), sql);
});

test('credentials are never part of the entry, the diff or the evidence helpers', () => {
  assert.doesNotMatch(DIFF, /password|passwd|secret|isolated_only_pw/i);
  assert.equal(JSON.stringify(ev.writeHeader.toString()).toLowerCase().includes('db_password'), false, 'the evidence header never records DB_PASSWORD');
});
