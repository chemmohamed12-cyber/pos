'use strict';
// Run with: node --test tools/testing/db-guard.test.js   (no database, no network: pg.Client.connect is a stub)
const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('./db-guard');

const entry = (over = {}) => ({
  id: 't-1', host: '127.0.0.1', port: 6001, adminDatabases: ['postgres'], databases: [], databasePatterns: ['^daii_test_biz_t[0-9]{2}[a-z0-9_]*$'],
  approvedBy: 'cto', approvedOn: '2026-10-11', identityEvidence: 'unit-test fixture', ...over,
});
const policyOf = (...entries) => ({ approved: entries.filter((e) => e.approvedBy), incomplete: 0 });
const T = (host, port, database) => ({ host, port, database });

test('default deny: empty approval list refuses everything, including a perfectly isolated-looking target', () => {
  assert.equal(guard.evaluate(T('127.0.0.1', 5544, 'daii_test_ambient'), policyOf()).allowed, false);
});

test('approved loopback entry allows only pattern-matching databases as business targets; postgres only as admin', () => {
  const p = policyOf(entry());
  assert.equal(guard.evaluate(T('127.0.0.1', 6001, 'daii_test_biz_t01_company_a'), p).role, 'business');
  assert.equal(guard.evaluate(T('localhost', 6001, 'daii_test_biz_t12'), p).allowed, true, 'localhost is the same loopback');
  assert.equal(guard.evaluate(T('127.0.0.1', 6001, 'postgres'), p).role, 'admin', 'postgres is an administrative connection only');
  assert.equal(guard.evaluate(T('127.0.0.1', 6001, 'postgres'), p, { businessOnly: true }).allowed, false, 'never a business target');
  for (const bad of ['daii_test_ambient', 'daii_test_fanout_ambient', 'some_other_db', 'daii_test_biz_t1', 'daii_test_biz_tXX', 'daii_test_biz_t01-x', 'template1', 'template0', 'restore_old_daii_dev', 'restore_quiet_daii_dev', 'restore_company_abc']) {
    assert.equal(guard.evaluate(T('127.0.0.1', 6001, bad), p).allowed, false, bad);
  }
  assert.equal(guard.evaluate(T('127.0.0.1', 6002, 'daii_test_biz_t01'), p).allowed, false, 'unlisted port');
});

test('hard denials cannot be approved: daii_dev, port 5433, production-like names, remote hosts', () => {
  const p = policyOf(
    entry({ port: 5433, databases: ['daii_dev', 'postgres'] }),
    entry({ id: 't-2', databases: ['daii_dev', 'daii_prod', 'live_copy', 'daii_staging'], databasePatterns: ['.*'] }),
    entry({ id: 't-3', host: 'db.example.com', databasePatterns: ['.*'] }),
  );
  assert.equal(guard.evaluate(T('127.0.0.1', 5433, 'postgres'), p).allowed, false);
  assert.equal(guard.evaluate(T('localhost', 5433, 'daii_test_x'), p).allowed, false);
  assert.equal(guard.evaluate(T('127.0.0.1', 6001, 'daii_dev'), p).allowed, false);
  assert.equal(guard.evaluate(T('127.0.0.1', 6001, 'daii_test_biz_t01_daii_dev'), p).allowed, false, 'any name containing daii_dev');
  assert.equal(guard.evaluate(T('127.0.0.1', 6001, 'DAII_DEV'), p).allowed, false, 'case-insensitive');
  assert.equal(guard.evaluate(T('127.0.0.1', 6001, 'daii_prod'), p).allowed, false);
  assert.equal(guard.evaluate(T('127.0.0.1', 6001, 'live_copy'), p).allowed, false);
  assert.equal(guard.evaluate(T('127.0.0.1', 6001, 'daii_staging'), p).allowed, false);
  assert.equal(guard.evaluate(T('db.example.com', 6001, 'daii_test_x'), p).allowed, false);
  assert.equal(guard.evaluate(T('10.0.0.5', 6001, 'daii_test_x'), p).allowed, false);
});

test('unknown / empty identity is refused', () => {
  const p = policyOf(entry());
  assert.equal(guard.evaluate(T('', 6001, 'daii_test_ambient'), p).allowed, false);
  assert.equal(guard.evaluate(T(undefined, 6001, 'daii_test_ambient'), p).allowed, false);
  assert.equal(guard.evaluate(T('127.0.0.1', undefined, 'daii_test_ambient'), p).allowed, false);
  assert.equal(guard.evaluate(T('127.0.0.1', 'abc', 'daii_test_ambient'), p).allowed, false);
  assert.equal(guard.evaluate(T('127.0.0.1', 6001, ''), p).allowed, false);
  assert.equal(guard.evaluate(T('127.0.0.1', 6001, undefined), p).allowed, false);
});

test('an entry without approvedBy / approvedOn / identityEvidence is ignored (a proposal is not an approval)', () => {
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'dbguard-'));
  const file = require('path').join(dir, 'p.json');
  require('fs').writeFileSync(file, JSON.stringify({ approved: [entry({ approvedBy: null }), entry({ id: 'x', identityEvidence: '' }), entry({ id: 'y', approvedOn: undefined })] }));
  const p = guard.loadPolicy(file);
  assert.equal(p.approved.length, 0);
  assert.equal(p.incomplete, 3);
  assert.equal(guard.evaluate(T('127.0.0.1', 6001, 'daii_test_ambient'), p).allowed, false);
});

test('an unreadable approval list fails closed', () => {
  assert.throws(() => guard.loadPolicy('Z:/does/not/exist.json'), guard.DbGuardError);
});

test('the shipped approval list approves nothing yet (D-2 not decided)', () => {
  const p = guard.loadPolicy();
  assert.equal(p.approved.length, 0, 'no approved entries until the CTO commits one');
});

test('ambient resolution: unset variables fall back to the application default daii_dev, which is refused', () => {
  const p = policyOf(entry());
  const amb = guard.effectiveAmbient({}, {});
  assert.deepEqual(amb, { host: 'localhost', port: '5432', database: 'daii_dev' });
  assert.throws(() => guard.preflight({ env: {}, dotenv: {}, policy: p }), /REFUSED/);
});

test('ambient resolution: backend/.env values (daii_dev on 5433) are refused; a shell override to an approved target passes', () => {
  const p = policyOf(entry());
  const dotenv = { DB_HOST: 'localhost', DB_PORT: '5433', DB_NAME: 'daii_dev' };
  assert.throws(() => guard.preflight({ env: {}, dotenv, policy: p }), /REFUSED/);
  const ok = guard.preflight({ env: { DB_HOST: '127.0.0.1', DB_PORT: '6001', DB_NAME: 'daii_test_biz_t00_unused' }, dotenv, policy: p });
  assert.throws(() => guard.preflight({ env: { DB_HOST: '127.0.0.1', DB_PORT: '6001', DB_NAME: 'postgres' }, dotenv, policy: p }), /administrative database/, 'the ambient configuration may never be postgres');
  assert.throws(() => guard.preflight({ env: { DB_HOST: '127.0.0.1', DB_PORT: '6001', DB_NAME: 'daii_test_ambient' }, dotenv, policy: p }), /REFUSED/);
  assert.equal(ok.decision.allowed, true);
  // partial override: only DB_NAME set in the shell, host/port still come from .env (5433) → refused
  assert.throws(() => guard.preflight({ env: { DB_NAME: 'daii_test_biz_t00_unused' }, dotenv, policy: p }), /REFUSED/);
});

test('refusal happens BEFORE any connection: a refused target never reaches the underlying connect (callback and promise styles)', async () => {
  let reached = 0;
  class FakeClient {
    constructor(p) { this.connectionParameters = p; }
    connect() { reached += 1; return Promise.resolve('connected'); }
  }
  guard.install({ pg: { Client: FakeClient }, policy: policyOf(entry()) });

  const bad = new FakeClient({ host: '127.0.0.1', port: 5433, database: 'daii_dev' });
  await assert.rejects(() => bad.connect(), /REFUSED connection/);
  await new Promise((resolve) => bad.connect((err) => { assert.match(err.message, /No socket was opened/); resolve(); }));
  assert.equal(reached, 0, 'the real connect was never invoked for a refused target');

  const good = new FakeClient({ host: '127.0.0.1', port: 6001, database: 'daii_test_biz_t01_x1' });
  assert.equal(await good.connect(), 'connected');
  assert.equal(reached, 1);

  // idempotent install
  guard.install({ pg: { Client: FakeClient }, policy: policyOf(entry()) });
  const bad2 = new FakeClient({ host: 'remote.example.com', port: 6001, database: 'daii_test_biz_t01_x1' });
  await assert.rejects(() => bad2.connect(), /not a loopback/);
  assert.equal(reached, 1);
});

test('manual HTTP scripts: only a loopback API base is allowed', () => {
  assert.doesNotThrow(() => guard.assertLoopbackApi('http://127.0.0.1:3601/api'));
  assert.doesNotThrow(() => guard.assertLoopbackApi('http://localhost:3601/api'));
  assert.throws(() => guard.assertLoopbackApi('https://daii.xnexustech.com/api'), /REFUSED API target/);
  assert.throws(() => guard.assertLoopbackApi('http://10.1.2.3:3601/api'), /REFUSED API target/);
  assert.throws(() => guard.assertLoopbackApi('not a url'), guard.DbGuardError);
});
