// Phase 0 — READ-ONLY source scans (no file is modified). Produces JSON used to build the Phase 0 appendices.
const fs = require('fs');
const path = require('path');
// Usage: node p0-scan.js <out-dir>   (run from anywhere; REPO_ROOT env overrides the repository root)
const R = (process.env.REPO_ROOT || path.resolve(__dirname, '../../../../')).split(path.sep).join('/') + '/';
const OUT = process.argv[2];
function walk(d, filt, out = []) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'migrations', 'testing'].includes(f.name) || f.name.startsWith('node_modules')) continue;
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p, filt, out);
    else if (filt(p)) out.push(p);
  }
  return out;
}
const LEGACY = ['admin', 'driver', 'finance', 'inventory_controller', 'sales_manager', 'sales_rep', 'sales_supervisor', 'warehouse_supervisor', 'warehouse_worker', 'sales_manager'];
const TPL = ['sales.manager', 'sales.rep', 'sales.viewer', 'inventory.manager', 'inventory.operator', 'inventory.viewer', 'logistics.manager', 'logistics.dispatcher', 'logistics.viewer', 'finance.manager', 'finance.clerk', 'finance.viewer', 'reporting.analyst', 'hr.manager', 'hr.viewer', 'manufacturing.manager', 'manufacturing.operator', 'manufacturing.viewer', 'accounting.manager', 'accounting.viewer'];
const KEYS = [...new Set([...LEGACY, ...TPL, 'sales_supervisor'])];
const rel = (p) => path.relative(R, p).replace(/\\/g, '/');

// ---------------- backend call-sites ----------------
const be = [];
for (const f of walk(R + 'backend/src', (p) => p.endsWith('.ts') && !p.endsWith('.spec.ts') && !/\.test-helper\.ts$/.test(p))) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((ln, i) => {
    const t = ln.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
    const found = KEYS.filter((k) => new RegExp("['\"`]" + k.replace('.', '\\.') + "['\"`]").test(ln));
    const decorator = /@RequireRole\(/.test(ln);
    const roleApi = /(hasRole|getRoleKeysForUser|getUserIdsForRole|assignRole|revokeRole|roles\.includes|userRoles\.includes|\.roles\b.*includes)/.test(ln);
    if (!found.length && !decorator && !roleApi) return;
    if (!found.length && roleApi && !decorator) {
      // role API usage without literal key (dynamic) — record separately
      be.push({ file: rel(f), line: i + 1, kind: 'role-api (no literal key)', keys: [], snippet: t.slice(0, 150) });
      return;
    }
    let kind = decorator ? '@RequireRole decorator' : /roles\s*:\s*\[/.test(ln) ? 'navigation/registry roles[]' : /const\s+[A-Z_]+.*=/.test(ln) || /^\s*['"\w]+\s*:\s*\[/.test(ln) ? 'constant map' : roleApi ? 'service check' : 'literal';
    be.push({ file: rel(f), line: i + 1, kind, keys: found, snippet: t.slice(0, 150) });
  });
}
// nav registry roles arrays are multi-line friendly: also pull from navigation-registry
// ---------------- frontend hasRole ----------------
const fe = [];
for (const f of walk(R + 'frontend/src', (p) => /\.(tsx?|jsx?)$/.test(p))) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((ln, i) => {
    if (!/hasRole\(|\.roles\b|user\??\.roles/.test(ln)) return;
    const t = ln.trim();
    if (t.startsWith('*') || t.startsWith('//')) return;
    const m = ln.match(/hasRole\(([^)]*)\)/);
    const args = m ? m[1].replace(/\s+/g, ' ') : '';
    const ctx = /\{\s*!?\(?hasRole|hasRole\([^)]*\)\s*&&|hasRole\([^)]*\)\s*\?/.test(ln) ? 'render gate' : /const\s+\w+\s*=\s*hasRole/.test(ln) ? 'derived flag' : /if\s*\(.*hasRole/.test(ln) ? 'logic branch' : m ? 'other' : 'roles list display';
    fe.push({ file: rel(f), line: i + 1, args, ctx, snippet: t.slice(0, 140) });
  });
}
// ---------------- controllers: routes + guards (platform plane) ----------------
const ctrls = walk(R + 'backend/src', (p) => p.endsWith('.controller.ts') && !p.endsWith('.spec.ts'));
const routes = [];
for (const f of ctrls) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split(/\r?\n/);
  const cm = src.match(/@Controller\(([^)]*)\)/);
  const base = cm ? cm[1].replace(/['"`]/g, '') : '';
  const classIdx = lines.findIndex((l) => /export class \w+Controller/.test(l));
  const classHead = lines.slice(Math.max(0, classIdx - 12), classIdx + 1).join(' ');
  const classGuards = [...classHead.matchAll(/@(UseGuards|RequireRole|RequirePermission|RequireModule)\(([^)]*)\)/g)].map((m) => '@' + m[1] + '(' + m[2].trim() + ')');
  const hasCompany = /CompanyContextGuard/.test(src);
  for (let i = classIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/@(Get|Post|Put|Patch|Delete)\(([^)]*)\)/);
    if (!m) continue;
    const dec = [];
    for (let j = i - 1; j >= Math.max(classIdx + 1, i - 8); j--) {
      const mm = [...lines[j].matchAll(/@(UseGuards|RequireRole|RequirePermission|Throttle|RequireModule)\(([^)]*)\)/g)];
      mm.forEach((x) => dec.push('@' + x[1] + '(' + x[2].trim() + ')'));
      if (/^\s*}\s*$/.test(lines[j]) || /async \w+\(/.test(lines[j])) break;
    }
    routes.push({ file: rel(f), controller: base, method: m[1].toUpperCase(), path: m[2].replace(/['"`]/g, ''), classGuards, routeGuards: dec, hasCompanyGuard: hasCompany });
  }
}
fs.writeFileSync(OUT + '/p0-be.json', JSON.stringify(be, null, 1));
fs.writeFileSync(OUT + '/p0-fe.json', JSON.stringify(fe, null, 1));
fs.writeFileSync(OUT + '/p0-routes.json', JSON.stringify(routes, null, 1));
console.log('backend callsites', be.length, 'frontend hasRole/roles', fe.length, 'routes', routes.length, 'noCompanyRoutes', routes.filter((r) => !r.hasCompanyGuard).length);
const byKind = {}; be.forEach((b) => (byKind[b.kind] = (byKind[b.kind] || 0) + 1)); console.log(byKind);
const byCtx = {}; fe.forEach((b) => (byCtx[b.ctx] = (byCtx[b.ctx] || 0) + 1)); console.log(byCtx);
