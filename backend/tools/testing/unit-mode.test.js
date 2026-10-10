'use strict';
// node --test tools/testing/unit-mode.test.js — static guarantees about the unit/DB separation. No database, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKEND = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(BACKEND, p), 'utf8');
const listed = () => read('tools/testing/unit-specs.txt').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('the reviewed list: unique, existing, inside src, spec files only', () => {
  const l = listed();
  assert.ok(l.length > 0);
  assert.equal(new Set(l).size, l.length, 'duplicates');
  for (const f of l) {
    assert.match(f, /^src\/.+\.spec\.ts$/, f);
    assert.ok(fs.existsSync(path.join(BACKEND, f)), `${f} does not exist`);
  }
});

test('no database-backed spec can be on the list (same static filter that produced the candidates)', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'unit-specs-candidates.js')], { cwd: BACKEND, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split(/\r?\n/).filter(Boolean);
  const allowed = new Set(out);
  const offenders = listed().filter((f) => !allowed.has(f));
  assert.deepEqual(offenders, [], 'specs on the unit list that the static database/network filter rejects');
  for (const f of listed()) assert.doesNotMatch(f, /real-pg/, f); // a *company-isolation* name alone is not disqualifying: some are mock-based and passed in deny-all unit mode
});

test('unit configuration has no DB guard bypass: it is a separate config with its own list, DB drivers/AppModule/harnesses blocked', () => {
  const cfg = read('jest.unit.config.js');
  assert.doesNotMatch(cfg, /globalSetup\s*:/);
  assert.match(cfg, /unit-specs\.txt/);
  for (const must of ['pg|pg-native', 'app\\\\.module', 'two-company-real-pg-harness', 'database/(data-source']) assert.ok(cfg.includes(must), `mapper for ${must}`);
  assert.match(cfg, /unit-mode-setup\.js/);
});

test('the database-backed configuration is untouched: still fail-closed under the guard', () => {
  const cfg = read('jest.config.js');
  assert.match(cfg, /globalSetup:\s*'<rootDir>\/\.\.\/tools\/testing\/jest-db-guard-global\.js'/);
  assert.match(cfg, /setupFiles:\s*\['<rootDir>\/\.\.\/tools\/testing\/jest-db-guard-setup\.js'\]/);
  assert.doesNotMatch(cfg, /unit-mode|unit-specs/);
});

test('npm scripts: test stays the guarded DB run; test:unit is the separate database-free run', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.test, 'jest');
  assert.match(pkg.scripts['test:unit'], /jest -c jest\.unit\.config\.js/);
  assert.doesNotMatch(pkg.scripts['test:unit'], /globalSetup/);
});

test('the database-backed config refuses to run with the shipped (empty) approval list, for the ambient configuration the app would use', () => {
  const guard = require('./db-guard');
  assert.throws(() => guard.preflight({ env: {}, dotenv: { DB_HOST: 'localhost', DB_PORT: '5433', DB_NAME: 'daii_dev' } }), /REFUSED/);
  assert.equal(guard.loadPolicy().approved.length, 0);
});
