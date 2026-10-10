'use strict';
/**
 * TEST-03 / axis 1 — READ-ONLY. Lists every direct import from one business domain into ANOTHER domain (non-spec files), classified by the importing file kind and
 * whether it is a type-only import. A direct import of another domain's concrete class bypasses the published contract (src/foundation/module-registry/contracts).
 * Usage: node tools/assessment/cross-domain-imports.js [outFile.json]
 */
const fs = require('fs'); const path = require('path');
const SRC = path.resolve(__dirname, '..', '..', 'src');
const out = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) scan(p); } })(SRC);
function scan(p) {
  const r = path.relative(SRC, p).split(path.sep).join('/'); const m = r.match(/^(domains|foundation)\/([^/]+)/); if (!m || m[1] !== 'domains') return;
  const mine = m[2]; const text = fs.readFileSync(p, 'utf8');
  for (const im of text.matchAll(/(import\s+(type\s+)?(?:[^;]*?)\sfrom\s+['"](\.[^'"]+)['"])/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(r), im[3])); const t = target.match(/^domains\/([^/]+)/);
    if (!t || t[1] === mine) continue;
    const kind = r.endsWith('.module.ts') ? 'module' : r.endsWith('.controller.ts') ? 'controller' : r.endsWith('.service.ts') ? 'service' : r.endsWith('entity.ts') || /entities?\.ts$/.test(r) ? 'entity' : 'other';
    const targetKind = /\.entity\.ts$|entities\.ts$/.test(target) ? 'entity' : /\.service$/.test(target) ? 'service' : /\.module$/.test(target) ? 'module' : /\/domain\//.test(target) ? 'domain-type' : 'other';
    out.push({ from: r, fromDomain: mine, toDomain: t[1], target, kind, targetKind, typeOnly: !!im[2] });
  }
}
const summary = {};
for (const e of out) { const k = `${e.kind}->${e.targetKind}${e.typeOnly ? ' (type-only)' : ''}`; summary[k] = (summary[k] ?? 0) + 1; }
const result = { total: out.length, summary, edges: out };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2));
console.log(JSON.stringify({ total: out.length, summary }, null, 1));
