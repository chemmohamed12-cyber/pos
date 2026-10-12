'use strict';
/**
 * Sequential runner for the business-test program: T-00, then T-01…T-12 in the FROZEN order, each as its own jest invocation
 * (--runInBand) under the DB guard. Stops at the first failing step (no later test runs on an unproven environment).
 *
 *   node tools/testing/biz-run.js [--only T-00,T-01]
 *
 * It refuses to start unless the DB guard accepts the configuration: the approved list must contain the entry for the dedicated cluster 127.0.0.1:5546.
 * It sets only: DB_HOST=127.0.0.1 DB_PORT=5546 DB_USER=daii_biz_test DB_PASSWORD (User-scope DAII_BIZ_PG_PASSWORD) DB_NAME=daii_test_biz_t00_unused.
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
  // informational reproducers of candidate defects (outside the frozen T-xx set; they never change a frozen verdict)
  ['F-AUD-002', 'src/foundation/testing/f-aud-reproducer.biz.real-pg.spec.ts'],
  ['F-TRS-001', 'src/foundation/testing/f-trs-reproducer.biz.real-pg.spec.ts'],
  // local capacity baseline (informational; D-10 numbers unapproved => no threshold)
  ['T-15', 'src/foundation/testing/t15-capacity-baseline.biz.real-pg.spec.ts'],
  ['T-16', 'src/foundation/testing/t16-capacity-http.biz.real-pg.spec.ts'],
  ['T-17', 'src/foundation/testing/f-plain-probes.biz.real-pg.spec.ts'],
  ['T-19', 'src/foundation/testing/t19-n01-endpoint-concurrency.biz.real-pg.spec.ts'],
  ['T-20', 'src/foundation/testing/n02-probes.biz.real-pg.spec.ts'],
  ['T-21', 'src/foundation/testing/t21-n02-fulfil-reservation.biz.real-pg.spec.ts'],
  ['T-22', 'src/foundation/testing/f-aud-rollback-reproducer.biz.real-pg.spec.ts'],
  ['T-23', 'src/foundation/testing/t23-audit-seq-hash.biz.real-pg.spec.ts'],
  ['T-24', 'src/foundation/testing/t24-n02-remaining.biz.real-pg.spec.ts'],
  ['T-25', 'src/foundation/testing/t25-h5-shipment-transitions.biz.real-pg.spec.ts'],
  ['T-26', 'src/foundation/testing/t26-audit-seq-lag-baseline.biz.real-pg.spec.ts'],
  // T-27 (Option A, NOT approved — CTO ruling 2026-10-12) is superseded by T-28 (Option B, fail closed); its file stays in the repository as the record of the withdrawn option.
  ['T-28', 'src/foundation/testing/t28-audit-seq-lag-fail-closed.biz.real-pg.spec.ts'],
  ['T-18', 'src/foundation/testing/test03-schema-drift.biz.real-pg.spec.ts'],
];

const only = (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '').split(',').filter(Boolean);
// Credentials: the dedicated test role's password lives ONLY in the Windows User-scope variable DAII_BIZ_PG_PASSWORD (set by biz-cluster-setup.js).
// It is read here into memory and handed to the jest child through its environment — never printed, never written to a file or an argument list.
function userVar(name) {
  if (process.env[name]) return process.env[name];
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`], { encoding: 'utf8' });
  return (r.stdout || '').trim() || undefined;
}
const env = {
  ...process.env,
  DB_HOST: '127.0.0.1', DB_PORT: String(userVar('DAII_BIZ_PG_PORT') || 5546), DB_USER: 'daii_biz_test', DB_PASSWORD: userVar('DAII_BIZ_PG_PASSWORD') || '', DB_NAME: 'daii_test_biz_t00_unused',
};
if (!env.DB_PASSWORD) { console.error('REFUSED: DAII_BIZ_PG_PASSWORD is not set (run tools/testing/biz-cluster-setup.js setup, or supply an authorised credential)'); process.exit(2); }

try {
  guard.preflight({ env, dotenv: {} });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

// Workstream C: --regression <list> runs the listed real-Postgres specs (one jest process each) with DAII_TEST_DB_NS=biz_t90_ so their disposable databases are
// named daii_test_biz_t90_* (already approved by the unchanged guard entry). Logs only; evidence = the per-spec result lines.
if (process.argv.includes('--regression')) {
  const list = fs.readFileSync(path.resolve(BACKEND, process.argv[process.argv.indexOf('--regression') + 1]), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const nsArg = process.env.REGRESSION_NS || 'biz_t90_'; // allows two runners on the shared cluster not to collide; must stay within the approved pattern
  if (!/^biz_t[0-9]{2}_$/.test(nsArg)) { console.error('REFUSED: REGRESSION_NS must look like biz_tNN_'); process.exit(2); }
  const renv = { ...env, DAII_TEST_DB_NS: nsArg };
  let bad = 0;
  for (const spec of list) {
    if (!fs.existsSync(path.join(BACKEND, spec))) { console.log(`NOT-FOUND ${spec}`); bad += 1; continue; }
    console.log(`\n=== REGRESSION: ${spec}`);
    const r = spawnSync(process.execPath, [path.join(BACKEND, 'node_modules', 'jest', 'bin', 'jest.js'), '--runInBand', '--testTimeout=600000', spec], { cwd: BACKEND, env: renv, stdio: 'inherit' });
    console.log(`RESULT ${r.status === 0 ? 'PASS' : 'FAIL'} ${spec}`);
    if (r.status !== 0) bad += 1;
  }
  console.log(`\nREGRESSION DONE: ${list.length - bad}/${list.length} passed`);
  process.exit(bad ? 1 : 0);
}

const keepGoing = process.argv.includes('--continue-after-failure'); // only for steps already triaged as independent; failures are still reported and the exit code stays non-zero
let failures = 0;
for (const [id, spec] of STEPS) {
  if (only.length && !only.some((o) => id.split('+').includes(o) || id === o)) continue;
  if (!fs.existsSync(path.join(BACKEND, spec))) { console.error(`NOT-WRITTEN: ${id} (${spec}) — run stops here`); process.exit(3); }
  console.log(`\n=== ${id}: ${spec}`);
  const r = spawnSync(process.execPath, [path.join(BACKEND, 'node_modules', 'jest', 'bin', 'jest.js'), '--runInBand', '--testTimeout=1800000', spec], { cwd: BACKEND, env, stdio: 'inherit' });
  if (r.status !== 0) {
    if (!keepGoing) { console.error(`\nSTOP: ${id} did not pass (exit ${r.status}). Later steps were not run.`); process.exit(r.status || 1); }
    failures += 1;
    console.error(`\nFAILED (continuing, flag --continue-after-failure): ${id} exit ${r.status}`);
  }
}
if (failures) { console.error(`\n${failures} step(s) failed.`); process.exit(1); }
console.log('\nALL REQUESTED STEPS PASSED');
