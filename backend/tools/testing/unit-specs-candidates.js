'use strict';
// Prints the specs that pass the STATIC database/network/process filter (candidates for tools/testing/unit-specs.txt).
// The list itself is committed and reviewed by hand; a candidate only joins it after it passes in unit mode (npm run test:unit).
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const EXCLUDE = [
  /AppModule|app\.module/, /real-pg/i, /new DataSource\(|DataSource\b.*initialize|getDataSource|createTwoCompanyHarness|two-company-real-pg-harness/,
  /createNestApplication|supertest|\.listen\(/, /child_process|\bspawn\(|\bexecFile\b|\bexec\(/, /process\.env\.(DB_|PG)/, /ambient-test-datasource|saas-characterization|saas-provisioning-kit|company-pool-worker/,
  /from ['"]pg['"]|require\(['"]pg['"]\)/, /ISOLATED_PG|5544|5433|5656/, /Test\.createTestingModule\(\{\s*imports:\s*\[/,
];

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

const all = walk(SRC);
const kept = [];
const dropped = [];
for (const f of all) {
  const t = fs.readFileSync(f, 'utf8');
  const rel = 'src/' + path.relative(SRC, f).split(path.sep).join('/');
  const hit = /real-pg|\.biz\./.test(rel) ? /real-pg-or-biz-file-name/ : EXCLUDE.find((re) => re.test(t));
  if (hit) dropped.push([rel, String(hit)]);
  else kept.push(rel);
}
if (process.argv.includes('--dropped')) dropped.forEach(([r, h]) => console.log(`${r}\t${h}`));
else kept.sort().forEach((r) => console.log(r));
console.error(`candidates: ${kept.length} of ${all.length} specs (dropped ${dropped.length})`);
