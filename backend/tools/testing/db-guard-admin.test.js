'use strict';
// node --test tools/testing/db-guard-admin.test.js
// Administrative-vs-business separation for the PROPOSED approval entry. No database, no network (pg.Client is a fake).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const guard = require('./db-guard');

const BACKEND = path.join(__dirname, '..', '..');
const proposed = JSON.parse(fs.readFileSync(path.join(BACKEND, 'docs', 'decisions', 'test-program', 'SUPERSEDED-APPROVAL-ENTRY-PROPOSED-5544.json'), 'utf8')).entry;
// the proposal with the placeholders filled, as the reviewer's commit would do (the guard ignores incomplete entries by design)
const entry = { ...proposed, approvedBy: 'cto (test fixture)', approvedOn: '2026-10-10' };
const complete = (over) => ({ approved: [{ ...entry, ...over }], incomplete: 0 });
const policy = { approved: [entry], incomplete: 0 };
const T = (database, port = 5544, host = '127.0.0.1') => ({ host, port, database });
const admin = (sql) => guard.checkAdminStatement(sql, T('postgres'), policy) || guard.checkStatement(sql, T('postgres'), policy);

test('the proposed entry: complete once approvedBy/approvedOn are filled; incomplete (ignored) as shipped; no role patterns; postgres only as admin', () => {
  assert.deepEqual(guard.loadPolicy().approved.map((a) => a.port).sort(), [5544, 5546], 'the shipped approval list has exactly the dedicated 5546 entry and the CTO-approved 5544 h3reg entry (2026-10-26); this file tests the SUPERSEDED 5544 proposal as a fixture');
  assert.equal(JSON.stringify(proposed.rolePatterns), '[]');
  assert.deepEqual(proposed.adminDatabases, ['postgres']);
  assert.deepEqual(proposed.databases, []);
  assert.equal(proposed.databasePatterns.length, 1);
  assert.equal(proposed.databasePatterns[0], '^daii_test_biz_t[0-9]{2}[a-z0-9_]*$');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dbg-'));
  const f = path.join(dir, 'p.json');
  fs.writeFileSync(f, JSON.stringify({ approved: [proposed] }));
  assert.equal(guard.loadPolicy(f).approved.length, 0, 'placeholders (<CTO name>) are still not an approval');
  for (const over of [{ approvedBy: null }, { approvedBy: '<CTO name>' }, { approvedBy: 'TBD' }, { approvedOn: '<YYYY-MM-DD>' }, { approvedOn: '10/10/2026' }, { approvedOn: '2026-13-45' }, { identityEvidence: '' }]) {
    fs.writeFileSync(f, JSON.stringify({ approved: [{ ...entry, ...over }] }));
    assert.equal(guard.loadPolicy(f).approved.length, 0, JSON.stringify(over));
  }
  fs.writeFileSync(f, JSON.stringify({ approved: [entry] }));
  assert.equal(guard.loadPolicy(f).approved.length, 1, 'a properly filled entry is accepted');
});

test('business targets: only disposable names t01..t99; every protected / system / ambient / restore / dev database is refused as a business target', () => {
  for (const ok of ['daii_test_biz_t01', 'daii_test_biz_t12_control_plane', 'daii_test_biz_t07_company_a', 'daii_test_biz_t99x', 'daii_test_biz_t001']) assert.equal(guard.evaluate(T(ok), policy).role, 'business', ok);
  const refused = ['postgres', 'template0', 'template1', 'daii_test_ambient', 'daii_test_fanout_ambient', 'daii_test_h3_ambient', 'daii_dev', 'daii', 'restore_old_daii_dev', 'restore_quiet_daii_dev',
    'restore_company_08cf24873de0411abf7938a9f39a6aa3', 'pool_b_663466', 'rehearsal_fresh', 'company_dabcc38172364032a8ed31a537c29027', 'daii_test_biz_t1', 'daii_test_biz_T01', 'daii_test_biz_t01-x', 'daii_test_biz_t01 ',
    'daii_test_biz_t01_prod', 'daii_test_biz_t01_daii_dev', 'daii_test_biz_t01_ambient', ''];
  for (const bad of refused) {
    const r = guard.evaluate(T(bad), policy, { businessOnly: true });
    assert.equal(r.allowed && r.role === 'business', false, `"${bad}" must not be a business target`);
  }
  assert.equal(guard.evaluate(T('postgres', 5433), policy).allowed, false, 'wrong port');
  assert.equal(guard.evaluate(T('postgres', 5656), policy).allowed, false, 'excluded port');
  assert.equal(guard.evaluate(T('postgres', 5544, 'db.example.com'), policy).allowed, false, 'remote host');
});

test('administrative connection: exact CREATE/DROP of approved disposable names + read-only catalog statements are allowed', () => {
  for (const n of ['daii_test_biz_t01_control_plane', 'daii_test_biz_t01_company_a', 'daii_test_biz_t01_company_b']) {
    assert.equal(admin(`CREATE DATABASE "${n}"`), null, n);
    assert.equal(admin(`DROP DATABASE IF EXISTS "${n}"`), null, n);
    assert.equal(admin(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`), null, n);
  }
  for (const ok of ['SELECT 1', 'SELECT version()', 'SELECT * FROM current_schema()', 'SHOW server_version', 'BEGIN READ ONLY', 'COMMIT', 'ROLLBACK',
    "SELECT datname FROM pg_database WHERE datname = 'daii_test_biz_t01_company_a'", "SELECT system_identifier::text FROM pg_control_system()", 'SET application_name = \'x\'']) assert.equal(admin(ok), null, ok);
});

test('administrative connection: business work is impossible — writes, DDL on objects, COPY, GRANT, extra CREATE DATABASE clauses, role and system changes', () => {
  for (const sql of [
    'INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'TRUNCATE t', 'CREATE TABLE t (id int)', 'DROP TABLE t', 'ALTER TABLE t ADD COLUMN x int', 'CREATE INDEX i ON t(id)',
    'COPY t FROM STDIN', 'GRANT ALL ON DATABASE postgres TO x', 'CREATE EXTENSION pgcrypto', 'VACUUM', 'CREATE SCHEMA s', 'DO $$ BEGIN PERFORM 1; END $$',
    'SELECT * INTO newt FROM t', 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', 'SELECT 1; DROP TABLE t', 'SELECT 1; INSERT INTO t VALUES (1)',
    'CREATE ROLE evil', 'DROP ROLE daii', "ALTER SYSTEM SET fsync = 'on'", 'CREATE TABLESPACE x LOCATION \'y\'',
  ]) assert.ok(admin(sql), `must be refused on postgres: ${sql}`);
  for (const sql of [
    'CREATE DATABASE "daii_test_biz_t01" TEMPLATE "restore_old_daii_dev"', 'CREATE DATABASE "daii_test_biz_t01" OWNER daii', 'CREATE DATABASE "daii_test_biz_t01" ENCODING \'UTF8\'',
    'CREATE DATABASE "daii_test_biz_t01" WITH TEMPLATE template0', 'DROP DATABASE "daii_test_biz_t01" CASCADE', 'ALTER DATABASE "daii_test_biz_t01" RENAME TO x',
  ]) assert.ok(admin(sql), `extra clauses must be refused: ${sql}`);
});

test('create/drop can affect ONLY the exact disposable names: ambient, restore copies, dev, system and look-alike names are refused', () => {
  for (const n of ['postgres', 'template0', 'template1', 'daii_test_ambient', 'daii_test_fanout_ambient', 'daii_test_h3_ambient', 'daii_dev', 'daii', 'restore_old_daii_dev', 'restore_quiet_daii_dev', 'restore_company_x',
    'pool_b_663466', 'rehearsal_fresh', 'company_abc', 'daii_test_biz_t1', 'daii_test_biz', 'daii_test_biz_t01_prod', 'DAII_TEST_AMBIENT']) {
    assert.ok(admin(`CREATE DATABASE "${n}"`), `CREATE ${n}`);
    assert.ok(admin(`DROP DATABASE IF EXISTS "${n}"`), `DROP ${n}`);
    assert.ok(admin(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`), `DROP FORCE ${n}`);
  }
  assert.ok(admin('DROP DATABASE IF EXISTS "daii_test_biz_t01_a"; DROP DATABASE IF EXISTS "daii_dev"'), 'second statement in a batch is checked too');
  assert.ok(admin('/* x */ DROP DATABASE\n"restore_quiet_daii_dev"'));
});

test('no role patterns are approved: any role DDL is refused on every connection type', () => {
  for (const db of ['postgres', 'daii_test_biz_t01_company_a']) {
    const c = T(db);
    assert.ok(guard.checkStatement('CREATE ROLE "daii_test_role_x"', c, policy), db);
    assert.ok(guard.checkStatement('ALTER ROLE daii SUPERUSER', c, policy), db);
    assert.ok(guard.checkStatement('DROP USER daii', c, policy), db);
  }
});

test('on a business connection (a disposable database) ordinary data statements work; database-level DDL is still pattern-bound', () => {
  const c = T('daii_test_biz_t01_company_a');
  for (const sql of ['INSERT INTO t VALUES (1)', 'CREATE TABLE x (id int)', 'UPDATE t SET a = 1']) assert.equal(guard.checkStatement(sql, c, policy), null, sql);
  assert.ok(guard.checkStatement('DROP DATABASE "daii_dev"', c, policy));
});

test('end to end with the guard installed on a fake pg.Client: refused statements never reach the driver', async () => {
  const sent = [];
  class FakeClient {
    constructor(p) { this.connectionParameters = p; }
    connect() { return Promise.resolve(); }
    query(q) { sent.push(typeof q === 'string' ? q : q.text); return Promise.resolve({ rows: [] }); }
  }
  guard.install({ pg: { Client: FakeClient }, policy });
  const pgAdmin = new FakeClient(T('postgres'));
  await pgAdmin.connect();
  await pgAdmin.query('CREATE DATABASE "daii_test_biz_t03_company_a"');
  await pgAdmin.query('SELECT 1');
  for (const sql of ['INSERT INTO x VALUES (1)', 'DROP DATABASE "restore_old_daii_dev"', 'CREATE DATABASE "daii_test_biz_t03" TEMPLATE "daii_dev"', 'CREATE TABLE t (id int)']) {
    await assert.rejects(() => pgAdmin.query(sql), /REFUSED statement/, sql);
  }
  assert.deepEqual(sent, ['CREATE DATABASE "daii_test_biz_t03_company_a"', 'SELECT 1'], 'only the two allowed statements reached the driver');
  // a business run against postgres is not possible: connecting is allowed (admin) but nothing business-like can be executed
  const biz = new FakeClient(T('daii_test_biz_t03_company_a'));
  await biz.connect();
  await biz.query('CREATE TABLE ok (id int)');
  assert.equal(sent.length, 3);
  // and connecting to protected databases is refused before any socket
  for (const bad of ['daii_test_ambient', 'restore_old_daii_dev', 'restore_quiet_daii_dev', 'daii_dev']) {
    await assert.rejects(() => new FakeClient(T(bad)).connect(), /REFUSED connection/, bad);
  }
});

test('the existing provisioning harness issues ONLY statements this policy allows (drift protection on its source)', () => {
  const src = fs.readFileSync(path.join(BACKEND, 'src', 'foundation', 'testing', 'two-company-real-pg-harness.ts'), 'utf8');
  const adminSql = [...src.matchAll(/admin\.query\(`([^`]*)`\)/g)].map((m) => m[1]);
  assert.deepEqual(adminSql.sort(), ['CREATE DATABASE "${name}"', 'DROP DATABASE IF EXISTS "${name}"', 'DROP DATABASE IF EXISTS "${name}" WITH (FORCE)'].sort(), 'the harness admin statements changed — re-review the policy');
  assert.match(src, /database: 'postgres'/, 'admin connection database');
  // Workstream C (2026-10-10): names are daii_test_${ns}${prefix}_*; ns comes ONLY from DAII_TEST_DB_NS and must be exactly biz_tNN_ (validated in the harness, fail-closed)
  assert.match(src, /daii_test_\$\{ns\}\$\{config\.namePrefix\}_control_plane/);
  assert.match(src, /daii_test_\$\{ns\}\$\{config\.namePrefix\}_company_a/);
  assert.match(src, /daii_test_\$\{ns\}\$\{config\.namePrefix\}_company_b/);
  assert.match(src, /process\.env\.DAII_TEST_DB_NS/);
  assert.match(src, /\^biz_t\[0-9\]\{2\}_\$/, 'the namespace validation');
  assert.match(src, /exceeds the PostgreSQL 63-character limit/);
  // every historical spec prefix, under the regression namespace, yields an approved business name within 63 characters, and the admin statements allow exactly those
  const prefixes = new Set();
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, f.name);
      if (f.isDirectory()) walk(fp);
      else if (f.name.endsWith('.ts')) for (const m of fs.readFileSync(fp, 'utf8').matchAll(/namePrefix: '([a-z0-9_]+)'/g)) prefixes.add(m[1]);
    }
  })(path.join(BACKEND, 'src'));
  assert.ok(prefixes.size > 50, 'found the spec prefixes');
  // a prefix containing prod|production|live|staging|ambient is refused by the guard's protected-name rule BY DESIGN (never weakened): those specs are NOT runnable under the guard
  const lookalike = /(prod|production|live|staging|daii_dev|ambient|^restore_)/i;
  const refusedByDesign = [];
  for (const pre of prefixes) {
    for (const suffix of ['control_plane', 'company_a', 'company_b']) {
      const name = `daii_test_biz_t90_${pre}_${suffix}`;
      assert.ok(name.length <= 63, `${name} too long`);
      if (lookalike.test(name)) {
        refusedByDesign.push(pre);
        assert.equal(guard.evaluate(T(name), policy).role, null, `${name} must stay refused`);
        continue;
      }
      assert.equal(guard.evaluate(T(name), policy).role, 'business', name);
      assert.equal(admin(adminSql[0].replace('${name}', name)), null, name);
    }
  }
  assert.ok(new Set(refusedByDesign).size < prefixes.size / 4, 'only a minority of prefixes are look-alikes');
  for (let i = 1; i <= 12; i += 1) {
    const prefix = `biz_t${String(i).padStart(2, '0')}`;
    for (const suffix of ['control_plane', 'company_a', 'company_b']) {
      const name = `daii_test_${prefix}_${suffix}`;
      assert.equal(admin(adminSql[0].replace('${name}', name)), null, name);
      assert.equal(admin(adminSql[1].replace('${name}', name)), null, name);
      assert.equal(admin(adminSql[2].replace('${name}', name)), null, name);
      assert.equal(guard.evaluate(T(name), policy).role, 'business', name);
    }
  }
  for (const wrongPrefix of ['wh_txn_isolation', 'nav02_policy', 'biz_t1', 'biz']) {
    assert.ok(admin(`CREATE DATABASE "daii_test_${wrongPrefix}_company_a"`) , `${wrongPrefix} must be refused`);
  }
});
