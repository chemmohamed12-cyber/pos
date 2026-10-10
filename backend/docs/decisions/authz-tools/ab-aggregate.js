require(require('path').join(__dirname, '..', '..', '..', 'tools', 'testing', 'db-guard')).install(); // DB guard (M-R2 §11): default deny — no connection to an unapproved database
// Aggregate interleaved A/B runs, per endpoint using only runs where BOTH sides returned 200 (429-throttled samples are discarded, never averaged in).
const fs = require('fs');
const files = process.argv.slice(2);
const runs = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log('endpoint            | valid runs | pre p50/p95 | F1 p50/p95 | d50  | d95');
runs[0].forEach((e0, k) => {
  const ok = runs.map((r) => r[k]).filter((e) => e.preStatus === 200 && e.curStatus === 200 && !e.badPre && !e.badCur);
  if (!ok.length) return console.log(e0.name, 'NO VALID RUN');
  const g = (s, p) => m(ok.map((e) => e[s][p]));
  const a50 = g('pre', 'p50'), a95 = g('pre', 'p95'), b50 = g('cur', 'p50'), b95 = g('cur', 'p95');
  console.log(e0.name.padEnd(19), '|', String(ok.length).padEnd(10), '|', a50.toFixed(1) + '/' + a95.toFixed(1), '|', b50.toFixed(1) + '/' + b95.toFixed(1), '|', ((b50 / a50 - 1) * 100).toFixed(0) + '% |', ((b95 / a95 - 1) * 100).toFixed(0) + '%');
});
