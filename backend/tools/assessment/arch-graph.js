'use strict';
/**
 * TEST-03 / axis 1 — READ-ONLY architecture analysis. Parses the relative imports of every non-spec .ts file under src/ and reports:
 *  - module edges (module = src/domains/<x> | src/foundation/<x> | src/<other>), with counts and sample files;
 *  - layering violations: foundation -> domains edges (the platform depending on a business module);
 *  - cross-domain edges (a domain importing another domain directly instead of through a foundation contract);
 *  - strongly connected components (cycles) at module level and at file level.
 * Usage: node tools/assessment/arch-graph.js [outFile.json]
 */
const fs = require('fs');
const path = require('path');
const SRC = path.resolve(__dirname, '..', '..', 'src');
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !e.name.endsWith('.d.ts')) files.push(p); } })(SRC);
const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');
const moduleOf = (r) => { const m = r.split('/'); if ((m[0] === 'domains' || m[0] === 'foundation') && m[1]) return `${m[0]}/${m[1]}`; return m[0]; };
const fileSet = new Set(files.map(rel));
const resolve = (from, spec) => { const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)); for (const c of [base + '.ts', base + '/index.ts', base]) if (fileSet.has(c)) return c; return null; };
const edges = new Map(); const fileEdges = new Map();
for (const f of files) {
  const r = rel(f); const text = fs.readFileSync(f, 'utf8');
  const specs = [...text.matchAll(/(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1] || m[2] || m[3]);
  for (const s of specs) {
    const t = resolve(r, s); if (!t) continue;
    (fileEdges.get(r) ?? fileEdges.set(r, new Set()).get(r)).add(t);
    const a = moduleOf(r); const b = moduleOf(t); if (a === b) continue;
    const k = `${a} -> ${b}`; const e = edges.get(k) ?? { from: a, to: b, count: 0, samples: [] };
    e.count += 1; if (e.samples.length < 3) e.samples.push(`${r} -> ${t}`); edges.set(k, e);
  }
}
function scc(nodes, adj) { // Tarjan
  let i = 0; const idx = new Map(); const low = new Map(); const st = []; const on = new Set(); const out = [];
  const strong = (v) => { idx.set(v, i); low.set(v, i); i += 1; st.push(v); on.add(v);
    for (const w of adj(v)) { if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w))); }
    if (low.get(v) === idx.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) out.push(c); } };
  for (const v of nodes) if (!idx.has(v)) strong(v); return out;
}
const modAdj = new Map(); for (const e of edges.values()) (modAdj.get(e.from) ?? modAdj.set(e.from, new Set()).get(e.from)).add(e.to);
const modules = [...new Set([...edges.values()].flatMap((e) => [e.from, e.to]))];
const modCycles = scc(modules, (v) => modAdj.get(v) ?? []);
const fileCycles = scc([...fileEdges.keys()], (v) => fileEdges.get(v) ?? []);
const all = [...edges.values()];
const foundationToDomain = all.filter((e) => e.from.startsWith('foundation/') && e.to.startsWith('domains/'));
const domainToDomain = all.filter((e) => e.from.startsWith('domains/') && e.to.startsWith('domains/'));
const modSize = {}; for (const f of files) { const m = moduleOf(rel(f)); modSize[m] = (modSize[m] ?? 0) + fs.readFileSync(f, 'utf8').split('\n').length; }
const result = {
  generatedFor: 'src/ (non-spec)', files: files.length, modules: Object.keys(modSize).length, moduleLoc: modSize,
  moduleEdges: all.length,
  foundationToDomain: foundationToDomain.map((e) => ({ ...e })),
  domainToDomain: domainToDomain.sort((a, b) => b.count - a.count).map((e) => ({ ...e })),
  moduleCycles: modCycles, fileCycleCount: fileCycles.length, fileCycleSizes: fileCycles.map((c) => c.length).sort((a, b) => b - a).slice(0, 15), fileCycleSamples: fileCycles.slice(0, 5).map((c) => c.slice(0, 6)),
};
const out = process.argv[2];
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ files: result.files, modules: result.modules, moduleEdges: result.moduleEdges, foundationToDomainEdges: foundationToDomain.length, domainToDomainEdges: domainToDomain.length, moduleCycles: modCycles.map((c) => c.join(' <-> ')), fileCycleCount: fileCycles.length, largestFileCycle: result.fileCycleSizes[0] ?? 0 }, null, 1));
