require(require('path').join(__dirname, '..', '..', '..', 'tools', 'testing', 'db-guard-register')); // DB guard (M-R2 §11): default deny, all layers — no connection to an unapproved database
// Aggregates scoped-user-latency.js runs: per endpoint, only runs where NO session saw a non-200 count (a throttled/failed sample is never averaged in).
// usage: node scoped-user-aggregate.js run1.json run2.json run3.json
const fs = require('fs');
const runs = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pc = (a, b) => ((a / b - 1) * 100).toFixed(0) + '%';
console.log('endpoint | valid | pre-F1 admin p50/p95/p99 | F6 admin p50/p95/p99 | F6 SCOPED p50/p95/p99 | scoped vs pre-F1 (p50 / p95) | scoped vs F6 admin (p50 / p95) | stmts/req admin -> scoped');
let worst = 0;
runs[0].rows.forEach((r0, k) => {
  const ok = runs.map((r) => r.rows[k]).filter((r) => !r.bad.preAdmin && !r.bad.curAdmin && !r.bad.curScoped);
  if (!ok.length) return console.log(r0.name, '| NO VALID RUN');
  const g = (s, p) => m(ok.map((r) => r[s][p]));
  const f = (s) => `${g(s, 'p50').toFixed(1)}/${g(s, 'p95').toFixed(1)}/${g(s, 'p99').toFixed(1)}`;
  const d95 = g('curScoped', 'p95') / g('preAdmin', 'p95') - 1;
  worst = Math.max(worst, d95);
  console.log(`${r0.name} | ${ok.length} | ${f('preAdmin')} | ${f('curAdmin')} | ${f('curScoped')} | ${pc(g('curScoped', 'p50'), g('preAdmin', 'p50'))} / ${pc(g('curScoped', 'p95'), g('preAdmin', 'p95'))} | ${pc(g('curScoped', 'p50'), g('curAdmin', 'p50'))} / ${pc(g('curScoped', 'p95'), g('curAdmin', 'p95'))} | ${m(ok.map((r) => r.stmPerRequest.curAdmin)).toFixed(1)} -> ${m(ok.map((r) => r.stmPerRequest.curScoped)).toFixed(1)}`);
});
console.log('worst scoped p95 vs pre-F1 baseline: ' + (worst * 100).toFixed(0) + '%');
