'use strict';
/**
 * R1 (TEST-03) — one-time, NON-DESTRUCTIVE import of the governing documents that lived in the workspace folder ABOVE the repository into the repository root, so a clean clone
 * contains everything the README links to. Copies bytes verbatim, never overwrites an existing destination, never deletes the source, and writes a manifest with SHA-256 hashes
 * (the originals were never under version control, so the manifest + the first commit are the provenance record). Only the listed files and folders are touched.
 *   node tools/validation/import-governing-docs.js <workspaceDir> <repoRoot> <manifestOut.md>
 */
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const [src, dst, manifestOut] = process.argv.slice(2);
if (!src || !dst || !manifestOut) { console.error('usage: import-governing-docs.js <workspaceDir> <repoRoot> <manifestOut.md>'); process.exit(2); }
const FILES = ['README.md', 'MASTER_ARCHITECTURE.md', 'MASTER_HANDOVER.md', 'MASTER_PROJECT_STATUS.md', 'LOCAL_DEVELOPMENT.md', 'FINAL_RELEASE_REPORT.md'];
const DIRS = ['architecture', 'planning', 'docs', '_source-audits'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rows = []; const skipped = [];
function copyOne(rel) {
  const from = path.join(src, rel); const to = path.join(dst, rel);
  const buf = fs.readFileSync(from);
  if (fs.existsSync(to)) { skipped.push({ rel, reason: sha(fs.readFileSync(to)) === sha(buf) ? 'identical file already present' : 'DIFFERENT file already present — not overwritten' }); return; }
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, buf);
  rows.push({ rel: rel.split(path.sep).join('/'), bytes: buf.length, sha256: sha(buf), mtime: fs.statSync(from).mtime.toISOString().slice(0, 10) });
}
function walk(rel) { for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) { const r = path.join(rel, e.name); if (e.isDirectory()) walk(r); else copyOne(r); } }
for (const f of FILES) if (fs.existsSync(path.join(src, f))) copyOne(f); else skipped.push({ rel: f, reason: 'not found in source' });
for (const d of DIRS) if (fs.existsSync(path.join(src, d))) walk(d); else skipped.push({ rel: d, reason: 'not found in source' });
const md = ['# Imported governing documents (R1, 2026-10-11)', '',
  'Until this change the master architecture, handover, development-setup, planning and governance documents lived in the workspace folder **above** this repository (not under version control), so a clean clone could not follow `backend/README.md`. They were copied here **verbatim** (bytes unchanged, originals untouched, nothing overwritten) so that this repository is self-sufficient. From now on the copies in this repository are the controlled versions; edit them here, with history.',
  '', 'Source: the workspace folder that contains this repository. Not imported on purpose: `_deploy`, `_dlt-test-001`, `_execution-baselines`, `_la1`, `_parity-evidence`, `_wp41`, `merge-116`, `cgi-bin`, server logs, `import-template.xlsx` (working/evidence/operational folders, large or specific to the hosting account), and the duplicate `backend/` and `frontend/` copies.',
  '', '| File | Bytes | SHA-256 | Source last modified |', '|---|---|---|---|', ...rows.map((r) => `| \`${r.rel}\` | ${r.bytes} | \`${r.sha256}\` | ${r.mtime} |`),
  '', skipped.length ? '## Not copied\n' + skipped.map((s) => `- \`${s.rel}\`: ${s.reason}`).join('\n') : 'No file was skipped.', ''].join('\n');
fs.writeFileSync(manifestOut, md);
console.log(`copied ${rows.length} files, skipped ${skipped.length}`);
