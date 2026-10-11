'use strict';
/**
 * READ-ONLY reviewer helper: re-reads a clean-snapshot evidence folder (evidence-clean-snapshot-…/<commit>/) and prints, per business-test directory, the run count, the commit and
 * dirtyPaths of each run header, the case counts by status and every non-PASS case; then reconciles the isolation log with its spec list and prints unit/guard tails.
 *   node tools/assessment/review-snapshot-evidence.js <evidenceDir>
 */
const fs = require('fs'); const path = require('path');
const dir = path.resolve(process.argv[2]);
const expected = fs.readFileSync(path.join(dir, 'SOURCE_COMMIT.txt'), 'utf8').trim();
console.log('SOURCE_COMMIT', expected);
const rows = []; let headerProblems = 0;
for (const t of fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^T-\d+$/.test(d.name)).map((d) => d.name).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))) {
  const runs = fs.readdirSync(path.join(dir, t));
  for (const r of runs) {
    const base = path.join(dir, t, r); if (!fs.existsSync(path.join(base, 'run-header.json'))) continue;
    const h = JSON.parse(fs.readFileSync(path.join(base, 'run-header.json'), 'utf8')); const res = fs.existsSync(path.join(base, 'result.json')) ? JSON.parse(fs.readFileSync(path.join(base, 'result.json'), 'utf8')) : null;
    const c = {}; const bad = [];
    for (const x of res?.results ?? []) { c[x.status] = (c[x.status] ?? 0) + 1; if (x.status !== 'PASS') bad.push(`${x.id.slice(0, 60)} [${x.status}]`); }
    const okHeader = h.commit === expected && Array.isArray(h.dirtyPaths) && h.dirtyPaths.length === 0; if (!okHeader) headerProblems += 1;
    rows.push({ t, r, runs: runs.length, commit: String(h.commit).slice(0, 8), dirty: (h.dirtyPaths ?? ['?']).length, okHeader, counts: c, bad });
  }
}
for (const x of rows) console.log(`${x.t.padEnd(5)} runs=${x.runs} commit=${x.commit} dirty=${x.dirty} ${x.okHeader ? 'HEADER-OK' : 'HEADER-PROBLEM'} ${JSON.stringify(x.counts)}${x.bad.length ? '\n        non-PASS: ' + x.bad.join(' | ') : ''}`);
console.log(`header problems: ${headerProblems} of ${rows.length}`);
// isolation reconciliation
const specList = fs.readFileSync(path.join(dir, 'regression-specs-all.txt'), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
const log = fs.readFileSync(path.join(dir, 'regression-all.log'), 'utf8').split(/\r?\n/);
const results = new Map(); let lastTests = '';
for (const l of log) { if (/^Tests:/.test(l)) lastTests = l; const m = l.match(/^RESULT (PASS|FAIL) (\S+)/); if (m) { results.set(m[2], { r: m[1], tests: lastTests.replace(/\s+/g, ' ') }); lastTests = ''; } }
const missing = specList.filter((s) => !results.has(s)); const extra = [...results.keys()].filter((s) => !specList.includes(s));
const dupes = specList.length - new Set(specList).size;
const fails = [...results.entries()].filter(([, v]) => v.r === 'FAIL'); const skipped = [...results.entries()].filter(([, v]) => v.r === 'PASS' && /skipped/.test(v.tests) && !/passed/.test(v.tests));
const totalTests = [...results.values()].reduce((s, v) => s + Number((v.tests.match(/Tests: (\d+) passed/) || [0, 0])[1]), 0);
console.log(`isolation: listed ${specList.length} (duplicates ${dupes}), results ${results.size}, PASS ${[...results.values()].filter((v) => v.r === 'PASS').length}, FAIL ${fails.length}, missing-from-log ${missing.length}, extra-in-log ${extra.length}, skipped-suites ${skipped.length}, individual tests passed (sum) ${totalTests}`);
for (const [s, v] of fails) console.log('  FAIL', s, v.tests);
for (const [s] of skipped) console.log('  SKIPPED (counted PASS by the runner)', s);
for (const s of missing) console.log('  MISSING', s);
console.log('log tail:', log.filter(Boolean).slice(-2).join(' | '));
for (const f of ['unit.log', 'guard.log']) { const t = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter((l) => /^(Test Suites|Tests):|^# (tests|pass|fail)/.test(l)); console.log(f, t.join(' | ')); }
