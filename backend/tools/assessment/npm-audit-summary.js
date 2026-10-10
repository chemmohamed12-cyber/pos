'use strict';
/**
 * D-01 — READ-ONLY summary of `npm audit --json` output (no package file is read for writing). Separates CONFIRMED advisories (from the registry advisory database) from deprecation and
 * license-metadata notices, and splits by direct/transitive and runtime/dev reachability as far as the audit report allows.
 * Usage: node tools/assessment/npm-audit-summary.js <audit.json> <package-lock.json> [out.md]
 */
const fs = require('fs');
const [auditFile, lockFile, outFile] = process.argv.slice(2);
const audit = JSON.parse(fs.readFileSync(auditFile, 'utf8')); const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')).packages || {};
const vulns = audit.vulnerabilities || {}; const meta = audit.metadata?.vulnerabilities || {};
const isDev = (name) => { const p = lock[`node_modules/${name}`]; return p ? !!(p.dev || p.devOptional) : null; };
const rows = Object.values(vulns).map((v) => {
  const via = (v.via || []).filter((x) => typeof x === 'object');
  return { name: v.name, severity: v.severity, direct: !!v.isDirect, scope: isDev(v.name) === null ? 'unknown' : isDev(v.name) ? 'dev only' : 'runtime', range: v.range, fixAvailable: v.fixAvailable === true ? 'yes (non-breaking)' : v.fixAvailable ? `yes — ${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (SEMVER-MAJOR)' : ''}` : 'no', advisories: via.map((a) => ({ title: a.title, url: a.url, severity: a.severity, range: a.range, cwe: a.cwe })), viaPackages: (v.via || []).filter((x) => typeof x === 'string') };
}).sort((a, b) => ['critical', 'high', 'moderate', 'low', 'info'].indexOf(a.severity) - ['critical', 'high', 'moderate', 'low', 'info'].indexOf(b.severity));
const md = [];
md.push(`Audit source: \`${auditFile.split(/[\\/]/).pop()}\` — packages scanned: ${audit.metadata?.dependencies?.total ?? '?'} (prod ${audit.metadata?.dependencies?.prod ?? '?'}, dev ${audit.metadata?.dependencies?.dev ?? '?'}). Counts by severity: critical ${meta.critical ?? 0}, high ${meta.high ?? 0}, moderate ${meta.moderate ?? 0}, low ${meta.low ?? 0}, info ${meta.info ?? 0}, total ${meta.total ?? rows.length}.`);
md.push(`Runtime-reachable vulnerable packages: ${rows.filter((r) => r.scope === 'runtime').length}; dev-only: ${rows.filter((r) => r.scope === 'dev only').length}; direct dependencies: ${rows.filter((r) => r.direct).length}.\n`);
md.push('| Package | Severity | Scope | Direct | Advisory (confirmed by the registry database) | Affected range | Fix available |', '|---|---|---|---|---|---|---|');
for (const r of rows) md.push(`| ${r.name} | ${r.severity} | ${r.scope} | ${r.direct ? 'yes' : 'no'} | ${r.advisories.length ? r.advisories.map((a) => `${a.title} (${a.url})`).join('<br>') : `via ${r.viaPackages.join(', ')}`} | ${r.range} | ${r.fixAvailable} |`);
const text = md.join('\n') + '\n'; if (outFile) fs.writeFileSync(outFile, text);
console.log(text.slice(0, 6000));
