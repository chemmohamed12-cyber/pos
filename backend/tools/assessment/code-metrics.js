'use strict';
/**
 * TEST-03 / axis 3 — READ-ONLY code-health metrics over src/ (non-spec): size distribution, type-safety escapes, suppressions, swallowed errors, TODO markers,
 * transaction-idiom counts. Counts are evidence for a debt register, not verdicts. Usage: node tools/assessment/code-metrics.js [outFile.json]
 */
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..'); const SRC = path.join(ROOT, 'src');
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) files.push(p); } })(SRC);
const isSpec = (f) => f.endsWith('.spec.ts') || f.includes(`${path.sep}testing${path.sep}`);
const prod = files.filter((f) => !isSpec(f) && !f.includes(`${path.sep}database${path.sep}migrations${path.sep}`));
const migrations = files.filter((f) => f.includes(`${path.sep}database${path.sep}migrations${path.sep}`) && !f.endsWith('.spec.ts'));
const specs = files.filter((f) => f.endsWith('.spec.ts'));
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const count = (text, re) => (text.match(re) || []).length;
const tot = { any: 0, asAny: 0, asNever: 0, asUnknownAs: 0, tsIgnore: 0, eslintDisable: 0, todo: 0, emptyCatch: 0, catchNoRethrowOrLog: 0, consoleLog: 0, synchronizeTrue: 0, rawQueryCalls: 0, advisoryLocks: 0, plainManagerJoinIdiom: 0, guardedJoinIdiom: 0, nonNullAssert: 0 };
const sizes = []; const perFile = [];
for (const f of prod) {
  const t = fs.readFileSync(f, 'utf8'); const loc = t.split('\n').length; sizes.push([rel(f), loc]);
  const c = { any: count(t, /:\s*any\b|<any>|\bany\[\]/g), asAny: count(t, /\bas any\b/g), asNever: count(t, /\bas never\b/g), asUnknownAs: count(t, /\bas unknown as\b/g), tsIgnore: count(t, /@ts-(ignore|expect-error|nocheck)/g), eslintDisable: count(t, /eslint-disable/g), todo: count(t, /\b(TODO|FIXME|HACK|XXX)\b/g), emptyCatch: count(t, /catch\s*(\([^)]*\))?\s*\{\s*\}/g), consoleLog: count(t, /console\.(log|warn|error)\(/g), synchronizeTrue: count(t, /synchronize:\s*true/g), rawQueryCalls: count(t, /\.query\(/g), advisoryLocks: count(t, /pg_advisory_xact_lock/g), plainManagerJoinIdiom: count(t, /manager \? (run|fn)\(manager\) : this\.dataSource\.transaction|\? (run|fn)\(manager\) :\s*this\.dataSource\.transaction/g), guardedJoinIdiom: count(t, /isTransactionActive/g), nonNullAssert: count(t, /[A-Za-z0-9_\)\]]!\./g) };
  for (const k of Object.keys(c)) tot[k] = (tot[k] ?? 0) + c[k]; perFile.push({ file: rel(f), loc, ...c });
}
sizes.sort((a, b) => b[1] - a[1]);
const buckets = { '<=200': 0, '201-500': 0, '501-1000': 0, '1001-2000': 0, '>2000': 0 };
for (const [, l] of sizes) buckets[l <= 200 ? '<=200' : l <= 500 ? '201-500' : l <= 1000 ? '501-1000' : l <= 2000 ? '1001-2000' : '>2000'] += 1;
const migLoc = migrations.reduce((s, f) => s + fs.readFileSync(f, 'utf8').split('\n').length, 0);
const specTexts = specs.map((f) => ({ f, t: fs.readFileSync(f, 'utf8') }));
const realPg = specTexts.filter((s) => /real-pg|company-isolation|setUpTwoCompanyHarness|new DataSource\(/.test(s.f + s.t.slice(0, 4000))).length;
const mockHeavy = specTexts.filter((s) => count(s.t, /jest\.fn\(|jest\.mock\(|as never|as unknown as/g) > 10).length;
const inertStubs = specTexts.filter((s) => /\{\} as never/.test(s.t)).length;
const result = {
  prodFiles: prod.length, prodLoc: sizes.reduce((s, x) => s + x[1], 0), migrationFiles: migrations.length, migrationLoc: migLoc, specFiles: specs.length,
  sizeBuckets: buckets, largest: sizes.slice(0, 15), totals: tot,
  specs: { total: specs.length, realPostgresOrIsolation: realPg, mockHeavy, usingInertStubs: inertStubs },
  topAnyFiles: perFile.sort((a, b) => b.any - a.any).slice(0, 8).map((x) => `${x.file}:${x.any}`),
};
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ ...result, perFile }, null, 1));
console.log(JSON.stringify(result, null, 1));
