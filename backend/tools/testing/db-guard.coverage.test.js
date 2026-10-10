'use strict';
// node --test tools/testing/db-guard.coverage.test.js
// Fail-closed inventory: every file under tools/ and docs/decisions/authz-tools/ that can reach a database must either load the
// guard or be an explicitly classified OPERATOR tool (a tool meant for real, non-test databases — it is NOT a test tool and must
// never be used by a test program). A new database-capable tool that is in neither set fails this test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..', '..');
const DB_CAPABLE = /(require\(['"]pg['"]\)|require\([^)]*node_modules\/pg['"]\)|from ['"]pg['"]|new DataSource\(|new Client\(|new Pool\(|child_process|execFile|spawn\(|createConnection)/;
const GUARDED = /db-guard/;
const OWN = new Set(['db-guard.js', 'db-guard-process.js', 'db-guard-register.js', 'jest-db-guard-global.js', 'jest-db-guard-setup.js', 'db-guard.test.js', 'db-guard-process.test.js', 'db-guard-statements.test.js', 'db-guard-admin.test.js', 'biz-evidence.js', 'biz-evidence.test.js', 'db-guard.coverage.test.js', 'blocked-db-driver.js', 'unit-mode-setup.js', 'unit-mode-blocked.js', 'unit-specs-candidates.js', 'unit-mode.test.js', 'probe.spec.js', 'jest.probe.config.js']);

// Operator tools: intentionally NOT guarded (they act on real/target databases chosen by the operator). Never run these from tests.
const OPERATOR = {
  'tools/maintenance/apply-manufacturing-master-data-migrations.js': 'operator maintenance tool for a real database',
  'tools/maintenance/relax-company-user-fks.js': 'operator maintenance tool for real Company databases',
  'tools/release-sim/local-deploy-harness.js': 'local release simulation against the operator-chosen host database (SIM_TARGET_DB); not a test program',
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|ts|mjs|cjs)$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

test('every database-capable tool is guarded or classified as an operator tool', () => {
  const files = [...walk(path.join(BACKEND, 'tools')), ...walk(path.join(BACKEND, 'docs', 'decisions', 'authz-tools'))];
  const problems = [];
  const seenOperator = new Set();
  let guarded = 0;
  for (const f of files) {
    const rel = path.relative(BACKEND, f).replace(/\\/g, '/');
    if (OWN.has(path.basename(f))) continue;
    const text = fs.readFileSync(f, 'utf8');
    if (!DB_CAPABLE.test(text)) continue;
    if (OPERATOR[rel]) { seenOperator.add(rel); continue; }
    if (GUARDED.test(text)) { guarded += 1; continue; }
    problems.push(`${rel}: database-capable and neither guarded nor classified as an operator tool`);
  }
  for (const rel of Object.keys(OPERATOR)) if (!seenOperator.has(rel)) problems.push(`${rel}: listed as operator tool but no longer database-capable or missing — update the list`);
  assert.deepEqual(problems, []);
  for (const must of ['tools/testing/bv-add-user.ts', 'tools/testing/bv-bootstrap.ts', 'tools/testing/bv-migrate-all.ts', 'tools/testing/bv-seed.ts', 'tools/testing/provision-isolated-ambient-db.js', 'docs/decisions/authz-tools/security-mutation-verification.js', 'docs/decisions/authz-tools/closure-http-verification.js']) {
    assert.match(fs.readFileSync(path.join(BACKEND, must), 'utf8'), GUARDED, must + ' must load the guard');
  }
  assert.ok(guarded >= 10, 'unexpectedly few guarded database-capable tools: ' + guarded);
});

test('jest is configured with the guard (globalSetup + setupFiles) and cannot silently lose it', () => {
  const cfg = fs.readFileSync(path.join(BACKEND, 'jest.config.js'), 'utf8');
  assert.match(cfg, /globalSetup:\s*'<rootDir>\/\.\.\/tools\/testing\/jest-db-guard-global\.js'/);
  assert.match(cfg, /setupFiles:\s*\['<rootDir>\/\.\.\/tools\/testing\/jest-db-guard-setup\.js'\]/);
});

test('non-pg database drivers are mapped to a throwing stub in jest (fail closed if one is ever installed)', () => {
  const cfg = fs.readFileSync(path.join(BACKEND, 'jest.config.js'), 'utf8');
  assert.match(cfg, /moduleNameMapper/);
  assert.match(cfg, /blocked-db-driver/);
  assert.throws(() => require('./blocked-db-driver'), /not covered by the DB guard/);
});

test('the shipped source tree uses only the pg driver (TypeORM type postgres)', () => {
  const offenders = [];
  for (const f of walk(path.join(BACKEND, 'src'))) {
    const t = fs.readFileSync(f, 'utf8');
    if (/type:\s*['"](mysql|mariadb|sqlite|better-sqlite3|mssql|oracle|mongodb|cockroachdb|sap)['"]/.test(t)) offenders.push(path.relative(BACKEND, f));
  }
  assert.deepEqual(offenders, []);
});
