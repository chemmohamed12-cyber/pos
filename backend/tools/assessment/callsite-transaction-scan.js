'use strict';
/**
 * TEST-03 / axis 3 — READ-ONLY heuristic. For each production call of a primitive that depends on the caller's manager being INSIDE a transaction
 * (numbering.getNextNumber, processEngine.transition, limits.consume, audit-free reads excluded), reports whether a transaction opener
 * (`.transaction(`, `isTransactionActive`, `withIdempotencyInTransaction`, `queryRunner`) appears in the preceding WINDOW lines of the same file.
 * It cannot prove the manager is plain at runtime: every "no opener" site is an INFERRED candidate that must be confirmed with a concurrent test (see T-17).
 * Usage: node tools/assessment/callsite-transaction-scan.js [outFile.json]
 */
const fs = require('fs'); const path = require('path');
const SRC = path.resolve(__dirname, '..', '..', 'src'); const WINDOW = 80;
const PRIMS = [{ name: 'numbering.getNextNumber', re: /\.getNextNumber\(/ }, { name: 'processEngine.transition', re: /(processEngine|process)\.transition\(/ }, { name: 'limits.consume', re: /(limits?|limitService)\.consume\(/ }];
const files = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !p.includes(`${path.sep}testing${path.sep}`) && !p.includes(`${path.sep}migrations${path.sep}`)) files.push(p); } })(SRC);
const opener = /\.transaction\(|isTransactionActive|withIdempotencyInTransaction|queryRunner|startTransaction/;
const out = []; const sum = {};
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((ln, i) => { for (const pr of PRIMS) if (pr.re.test(ln) && !/^\s*(\/\/|\*)/.test(ln)) {
    const from = Math.max(0, i - WINDOW); const win = lines.slice(from, i + 1).join('\n'); const covered = opener.test(win);
    const rel = path.relative(SRC, f).split(path.sep).join('/'); out.push({ prim: pr.name, file: rel, line: i + 1, transactionOpenerInPrecedingWindow: covered });
    const k = `${pr.name} | ${covered ? 'opener nearby' : 'NO opener nearby'}`; sum[k] = (sum[k] ?? 0) + 1;
  } });
}
const candidates = out.filter((o) => !o.transactionOpenerInPrecedingWindow);
const result = { window: WINDOW, summary: sum, noOpenerSites: candidates.map((c) => `${c.prim} ${c.file}:${c.line}`) };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ ...result, all: out }, null, 1));
console.log(JSON.stringify(result, null, 1));
