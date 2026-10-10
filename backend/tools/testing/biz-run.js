'use strict';
/**
 * Sequential runner for the business-test program: T-00, then T-01…T-12 in the FROZEN order, each as its own jest invocation
 * (--runInBand) under the DB guard. Stops at the first failing step (no later test runs on an unproven environment).
 *
 *   ISOLATED_PG_PASSWORD=<isolated test credential> node tools/testing/biz-run.js [--only T-00,T-01]
 *
 * It refuses to start unless the DB guard accepts the configuration: the approved list must contain the entry for 127.0.0.1:5544.
 * It sets only: DB_HOST=127.0.0.1 DB_PORT=5544 DB_USER=isolated_admin DB_PASSWORD (from ISOLATED_PG_PASSWORD) DB_NAME=daii_test_biz_t00_unused.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const guard = require('./db-guard');

const BACKEND = path.resolve(__dirname, '..', '..');
// execution order (frozen): T-00; T-01..T-04; T-05..T-08; T-09; T-11..T-12; T-10.  Files that do not exist yet are reported as NOT-WRITTEN and stop the run.
const STEPS = [
  ['T-00', 'src/foundation/testing/biz-harness-smoke.biz.real-pg.spec.ts'],
  ['T-01+T-02', 'src/foundation/testing/t01-t02-oversell.biz.real-pg.spec.ts'],
  ['T-03+T-04', 'src/foundation/testing/t03-t04-concurrency.biz.real-pg.spec.ts'],
  ['T-05', 'src/foundation/testing/t05-treasury.biz.real-pg.spec.ts'],
  ['T-06', 'src/foundation/testing/t06-collection-idempotency.biz.real-pg.spec.ts'],
  ['T-07', 'src/foundation/testing/t07-returns.biz.real-pg.spec.ts'],
  ['T-08', 'src/foundation/testing/t08-payment-apply.biz.real-pg.spec.ts'],
  ['T-09', 'src/foundation/testing/t09-inventory-movements-http.biz.real-pg.spec.ts'],
  ['T-11', 'src/foundation/testing/t11-failure-recovery.biz.real-pg.spec.ts'],
  ['T-12', 'src/foundation/testing/t12-connection-loss.biz.real-pg.spec.ts'],
  ['T-10', 'src/foundation/testing/t10-reconciliation.biz.real-pg.spec.ts'],
];

const only = (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '').split(',').filter(Boolean);
const env = {
  ...process.env,
  DB_HOST: '127.0.0.1', DB_PORT: '5544', DB_USER: 'isolated_admin', DB_PASSWORD: process.env.ISOLATED_PG_PASSWORD || '', DB_NAME: 'daii_test_biz_t00_unused',
};
if (!env.DB_PASSWORD) { console.error('REFUSED: set ISOLATED_PG_PASSWORD (the isolated test credential)'); process.exit(2); }

try {
  guard.preflight({ env, dotenv: {} });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

for (const [id, spec] of STEPS) {
  if (only.length && !only.some((o) => id.split('+').includes(o) || id === o)) continue;
  if (!fs.existsSync(path.join(BACKEND, spec))) { console.error(`NOT-WRITTEN: ${id} (${spec}) — run stops here`); process.exit(3); }
  console.log(`\n=== ${id}: ${spec}`);
  const r = spawnSync(process.execPath, [path.join(BACKEND, 'node_modules', 'jest', 'bin', 'jest.js'), '--runInBand', '--testTimeout=1800000', spec], { cwd: BACKEND, env, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`\nSTOP: ${id} did not pass (exit ${r.status}). Later steps were not run.`); process.exit(r.status || 1); }
}
console.log('\nALL REQUESTED STEPS PASSED');
