'use strict';
/**
 * TEST-03 / axis 5 — READ-ONLY. For every exported service/controller class, counts how many spec files reference it by name, and classifies the referencing specs as
 * real-database (harness / DataSource) or mock/unit. This is a REFERENCE map, not line coverage: a reference does not prove the behaviour is asserted.
 * Usage: node tools/assessment/test-reference-map.js [outFile.json]
 */
const fs = require('fs'); const path = require('path');
const SRC = path.resolve(__dirname, '..', '..', 'src'); const prod = []; const specs = [];
(function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (e.name.endsWith('.spec.ts')) specs.push(p); else if (/\.(service|controller)\.ts$/.test(e.name)) prod.push(p); } })(SRC);
const specInfo = specs.map((f) => { const t = fs.readFileSync(f, 'utf8'); return { f: path.relative(SRC, f).split(path.sep).join('/'), t, realDb: /setUpTwoCompanyHarness|new DataSource\(|real-pg|company-isolation|setUpBiz|setUpFinance/.test(f + t.slice(0, 6000)) }; });
const rows = [];
for (const f of prod) {
  const t = fs.readFileSync(f, 'utf8'); const cls = (t.match(/export class (\w+)/) || [])[1]; if (!cls) continue;
  const re = new RegExp(`\\b${cls}\\b`);
  const refs = specInfo.filter((s) => re.test(s.t));
  rows.push({ file: path.relative(SRC, f).split(path.sep).join('/'), cls, loc: t.split('\n').length, specs: refs.length, realDbSpecs: refs.filter((s) => s.realDb).length });
}
const zero = rows.filter((r) => r.specs === 0); const noReal = rows.filter((r) => r.specs > 0 && r.realDbSpecs === 0);
const result = { classes: rows.length, withNoSpecReference: zero.length, referencedOnlyByMockOrUnitSpecs: noReal.length, withRealDatabaseSpec: rows.length - zero.length - noReal.length,
  noSpecLargest: zero.sort((a, b) => b.loc - a.loc).slice(0, 25).map((r) => `${r.file} (${r.loc} LOC)`), mockOnlyLargest: noReal.sort((a, b) => b.loc - a.loc).slice(0, 25).map((r) => `${r.file} (${r.loc} LOC, ${r.specs} spec)`) };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ ...result, rows }, null, 1));
console.log(JSON.stringify(result, null, 1));
