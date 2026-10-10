'use strict';
/**
 * TEST-03 / axis 4 — READ-ONLY. Static scan of every *.controller.ts: which guards are applied at class level, how many routes exist, how many routes carry an explicit
 * permission decorator, and which controllers reference NO authentication guard at all (candidate public surfaces to be reviewed by hand).
 * Static scanning cannot prove runtime behaviour (global guards, inherited decorators): results are INFERRED until reproduced by a test.
 * Usage: node tools/assessment/controller-guard-scan.js [outFile.json]
 */
const fs = require('fs'); const path = require('path');
const SRC = path.resolve(__dirname, '..', '..', 'src'); const list = [];
(function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (e.name.endsWith('.controller.ts')) list.push(p); } })(SRC);
const rows = []; let routes = 0; let perm = 0;
for (const f of list) {
  const t = fs.readFileSync(f, 'utf8'); const rel = path.relative(SRC, f).split(path.sep).join('/');
  const cls = t.indexOf('export class'); const head = t.slice(Math.max(0, cls - 600), cls);
  const classGuards = [...head.matchAll(/@UseGuards\(([^)]*)\)/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
  const r = (t.match(/@(Get|Post|Put|Patch|Delete)\(/g) || []).length; const p = (t.match(/@RequirePermission\(/g) || []).length;
  const methodGuards = [...t.slice(cls).matchAll(/@UseGuards\(([^)]*)\)/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
  const auth = new Set([...classGuards, ...methodGuards].filter((g) => /Auth|Guard/.test(g)));
  routes += r; perm += p;
  rows.push({ file: rel, routes: r, classGuards, methodGuards: [...new Set(methodGuards)], requirePermission: p, authGuardReferenced: [...auth].some((g) => /JwtAuthGuard|IntegrationAuthGuard|PlatformGuard|InstallationAdminGuard|Guard/.test(g)), jwt: /JwtAuthGuard/.test(t), companyContext: /CompanyContextGuard/.test(t), platformGuard: /PlatformGuard|InstallationAdmin/.test(t) });
}
const noJwt = rows.filter((r) => !r.jwt);
const noAnyGuard = rows.filter((r) => r.classGuards.length === 0 && r.methodGuards.length === 0);
const noCompanyCtx = rows.filter((r) => r.jwt && !r.companyContext && !r.platformGuard);
const result = { controllers: rows.length, routes, requirePermissionDecorators: perm, controllersWithoutJwtAuthGuard: noJwt.map((r) => `${r.file} (routes=${r.routes})`), controllersWithNoGuardAtAll: noAnyGuard.map((r) => `${r.file} (routes=${r.routes})`), jwtButNoCompanyContextNorPlatformGuard: noCompanyCtx.map((r) => `${r.file} (routes=${r.routes})`) };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ ...result, rows }, null, 1));
console.log(JSON.stringify(result, null, 1));
