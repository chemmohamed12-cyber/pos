'use strict';
/**
 * TEST-03 / axis 9 — READ-ONLY, OFFLINE license inventory from package-lock.json (backend and frontend). No network is used. The lockfile `license` field is the
 * publisher's declaration; it is evidence for triage, NOT legal advice. Packages without a declared license, with copyleft or non-standard terms are flagged for a legal opinion.
 * Usage: node tools/assessment/license-scan.js [outFile.json]
 */
const fs = require('fs'); const path = require('path');
const targets = { backend: path.resolve(__dirname, '..', '..', 'package-lock.json'), frontend: path.resolve(__dirname, '..', '..', '..', 'frontend', 'package-lock.json') };
const copyleft = /(^|[^L])GPL|AGPL|LGPL|SSPL|EUPL|MPL|CC-BY-SA|OSL|CPAL|BUSL|Commons-Clause|Elastic/i;
const out = {};
for (const [name, file] of Object.entries(targets)) {
  if (!fs.existsSync(file)) { out[name] = { missing: true }; continue; }
  const lock = JSON.parse(fs.readFileSync(file, 'utf8')); const pk = lock.packages || {};
  const byLicense = {}; const prodByLicense = {}; const flagged = []; let total = 0; let prod = 0;
  for (const [p, v] of Object.entries(pk)) {
    if (!p) continue; total += 1; const lic = typeof v.license === 'string' ? v.license : v.license?.type ?? (Array.isArray(v.licenses) ? v.licenses.map((x) => x.type).join(' OR ') : 'UNDECLARED');
    byLicense[lic] = (byLicense[lic] || 0) + 1; const isDev = !!v.dev || !!v.devOptional; if (!isDev) { prod += 1; prodByLicense[lic] = (prodByLicense[lic] || 0) + 1; }
    if (lic === 'UNDECLARED' || /UNLICENSED|SEE LICENSE/i.test(lic) || copyleft.test(lic)) flagged.push({ package: p.replace(/^node_modules\//, ''), version: v.version, license: lic, scope: isDev ? 'dev' : 'runtime' });
  }
  out[name] = { total, runtime: prod, productionLicenses: prodByLicense, allLicenses: byLicense, flagged };
}
const projectLicense = ['LICENSE', 'LICENSE.md', 'LICENCE', 'COPYING'].flatMap((f) => [path.resolve(__dirname, '..', '..', f), path.resolve(__dirname, '..', '..', '..', f)]).filter(fs.existsSync);
const pkgJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
out.project = { packageJsonLicense: pkgJson.license ?? null, private: pkgJson.private ?? null, licenseFilesFound: projectLicense };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
for (const k of ['backend', 'frontend']) { const o = out[k]; if (o.missing) { console.log(k, 'lockfile missing'); continue; } console.log(k, 'packages', o.total, 'runtime', o.runtime, 'runtime licenses', JSON.stringify(o.productionLicenses), 'flagged', o.flagged.length); for (const f of o.flagged.slice(0, 12)) console.log('   ', JSON.stringify(f)); }
console.log('project', JSON.stringify(out.project));
