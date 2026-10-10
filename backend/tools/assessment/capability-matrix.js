'use strict';
/**
 * TEST-03 / axis 10 — READ-ONLY. Builds the implemented-vs-assessed capability matrix per business domain from the source tree and the preserved regression logs:
 * which layers exist (controller / service / entity / migration tag), how many routes, which database-backed isolation specs exist, and what the last recorded run of each said
 * (PASS / FAIL / NOT RUN) in docs/decisions/evidence-2026-10-10-biz/run-logs/regression-*.log. "Implemented" is judged only by the presence of controller+service code;
 * a domain without them is reported NOT YET IMPLEMENTED (never PASS by default). Usage: node tools/assessment/capability-matrix.js [outFile.md]
 */
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..'); const SRC = path.join(ROOT, 'src');
const logsDir = path.join(ROOT, 'docs', 'decisions', 'evidence-2026-10-10-biz', 'run-logs');
const results = new Map();
for (const f of fs.readdirSync(logsDir).filter((n) => /^regression-\d\.log$/.test(n))) {
  let lastTests = '';
  for (const l of fs.readFileSync(path.join(logsDir, f), 'utf8').split(/\r?\n/)) {
    if (/^Tests:/.test(l)) lastTests = l;
    const m = l.match(/^RESULT (PASS|FAIL) (\S+)/);
    // jest exits 0 for a fully skipped suite, so the runner prints PASS: a suite whose Tests line has skipped tests and none passed is NOT a pass
    if (m) { results.set(m[2], m[1] === 'PASS' && /skipped/.test(lastTests) && !/passed/.test(lastTests) ? 'NOT RUN' : m[1]); lastTests = ''; }
  }
}
const walk = (d, acc = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, acc); else acc.push(p); } return acc; };
const tags = fs.readdirSync(path.join(SRC, 'database', 'migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const rows = [];
for (const dom of fs.readdirSync(path.join(SRC, 'domains'))) {
  const files = walk(path.join(SRC, 'domains', dom)).map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  const ctrl = files.filter((f) => f.endsWith('.controller.ts')); const svc = files.filter((f) => f.endsWith('.service.ts')); const ent = files.filter((f) => /\.entity\.ts$/.test(f));
  const routes = ctrl.reduce((n, f) => n + (fs.readFileSync(path.join(ROOT, f), 'utf8').match(/@(Get|Post|Put|Patch|Delete)\(/g) || []).length, 0);
  const specs = files.filter((f) => f.endsWith('.spec.ts')); const iso = specs.filter((f) => /company-isolation|real-pg|setUpTwoCompanyHarness/.test(f) || /setUpTwoCompanyHarness/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  const state = iso.map((f) => results.get(f) ?? 'NOT RUN');
  const isoStatus = iso.length === 0 ? 'no DB-backed spec' : state.every((s) => s === 'PASS') ? `PASS (${iso.length})` : state.includes('FAIL') ? `FAIL (${state.filter((s) => s === 'FAIL').length}/${iso.length})` : `${state.filter((s) => s === 'PASS').length}/${iso.length} PASS, ${state.filter((s) => s === 'NOT RUN').length} NOT RUN`;
  const implemented = ctrl.length > 0 && svc.length > 0 ? 'implemented' : svc.length > 0 || ctrl.length > 0 ? 'partial (no ' + (ctrl.length ? 'service' : 'controller') + ')' : 'NOT YET IMPLEMENTED';
  rows.push({ dom, implemented, controllers: ctrl.length, routes, services: svc.length, entities: ent.length, specs: specs.length, isoStatus });
}
const md = ['| Domain | Code state | Controllers / routes | Services | Entities | Specs | DB-backed isolation specs (last recorded run) |', '|---|---|---|---|---|---|---|', ...rows.map((r) => `| ${r.dom} | ${r.implemented} | ${r.controllers} / ${r.routes} | ${r.services} | ${r.entities} | ${r.specs} | ${r.isoStatus} |`)].join('\n');
if (process.argv[2]) fs.writeFileSync(process.argv[2], md + '\n');
console.log(md);
console.log('\nmigration tags:', tags.join(', '), '| recorded spec results:', results.size);
