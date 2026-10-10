'use strict';
/**
 * R1 — documentation link check, run from a CLEAN CHECKOUT (CI). Scans the governing documents for relative references and fails when one does not resolve inside the repository:
 *   - Markdown links  [text](relative/path#anchor)
 *   - back-ticked paths that start with ./ or ../   (the README style: `../LOCAL_DEVELOPMENT.md`)
 * Intentionally external references (source systems that live outside this repository by design, per the README) are listed in KNOWN_EXTERNAL with the reason; they are reported but do not fail.
 * Usage: node tools/validation/check-doc-links.js [--json out.json]   (exit 1 when an unresolved, non-allow-listed link exists)
 */
const fs = require('fs'); const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..'); // release-new
const ROOTS = ['README.md', 'MASTER_ARCHITECTURE.md', 'MASTER_HANDOVER.md', 'MASTER_PROJECT_STATUS.md', 'LOCAL_DEVELOPMENT.md', 'FINAL_RELEASE_REPORT.md', 'architecture', 'planning', 'docs', '_source-audits', 'backend/README.md', 'backend/docs/DAII_ENGINEERING_GOVERNANCE.md'];
const KNOWN_EXTERNAL = [
  { re: /(^|\/)(baseline|30|xnexus-website)(\/|$)/, why: 'XNEXUS source systems referenced as read-only inspiration; outside this repository by design (see README "Daii is NOT a clone of …")' },
  { re: /^(\.\.\/)+(\.\.\/)?(1-hosting|hosting)\b/, why: 'workspace-level path outside the repository' },
  { re: /LOCAL_DEV_CREDENTIALS\.md$/, why: 'credentials file — deliberately never placed under version control' },
  { re: /^\.\/storage\/media$/, why: 'runtime upload directory created by the application, not a document' },
  { re: /backend\/src\/(database\/migrations\/\d{13}-|domains\/.*\.spec\.ts)/, file: /HANDOVER_SALES_ORDER_TREASURY_WAREHOUSE\.md$/, why: 'historical handover written before migrations were split into per-tag folders; kept verbatim as the authoritative record of that date' },
];
const files = [];
function collect(rel) { const p = path.join(REPO, rel); if (!fs.existsSync(p)) return; const st = fs.statSync(p); if (st.isDirectory()) { for (const e of fs.readdirSync(p)) collect(path.join(rel, e)); } else if (p.endsWith('.md')) files.push(rel); }
ROOTS.forEach(collect);
const problems = []; const external = []; let checked = 0;
for (const rel of files) {
  const text = fs.readFileSync(path.join(REPO, rel), 'utf8'); const dir = path.dirname(path.join(REPO, rel));
  const refs = new Set();
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) refs.add(m[1]);
  for (const m of text.matchAll(/`(\.{1,2}\/[^`\s]+)`/g)) refs.add(m[1]);
  for (const raw of refs) {
    if (/^(https?:|mailto:|#|data:)/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split('#')[0]).replace(/[),.;:]+$/, ''); if (!target || /[*<>{}$|]/.test(target)) continue;
    checked += 1;
    const abs = path.resolve(dir, target);
    if (abs.startsWith(REPO) && fs.existsSync(abs)) continue;
    const ext = KNOWN_EXTERNAL.find((k) => k.re.test(target) && (!k.file || k.file.test(rel)));
    if (ext) { external.push({ file: rel, ref: raw, why: ext.why }); continue; }
    problems.push({ file: rel.split(path.sep).join('/'), ref: raw });
  }
}
const out = { filesScanned: files.length, referencesChecked: checked, unresolved: problems, knownExternal: external };
const j = process.argv.indexOf('--json'); if (j >= 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(out, null, 1));
console.log(`doc-link check: ${files.length} files, ${checked} references, ${problems.length} unresolved, ${external.length} known-external`);
for (const p of problems.slice(0, 60)) console.log(`  UNRESOLVED ${p.file} -> ${p.ref}`);
process.exit(problems.length ? 1 : 0);
