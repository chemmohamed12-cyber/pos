'use strict';
/**
 * N-01 / TEST-03 — READ-ONLY. Individual classification of every production call of NumberingService.getNextNumber and ProcessEngineService.transition:
 *   - the manager argument actually passed (last argument text);
 *   - the enclosing method and whether it declares a `manager?: EntityManager` parameter (i.e. may be handed a plain manager by its caller);
 *   - whether that enclosing method name is called from a *.controller.ts (heuristic reachability from an HTTP request with `req.companyContext.dataSource.manager`).
 * Classes: TX-CALLBACK (argument is a callback-scoped transaction manager: protected before and after the fix) · CALLER-MANAGER (argument is the method's own `manager`: could be plain before the fix;
 * safe after `runInTransaction`) · NO-MANAGER (own default-DataSource transaction: safe) · OTHER (needs manual review). INFERRED: reachability is name-based.
 * Usage: node tools/assessment/callsite-table.js [outFile.json] [outFile.md]
 */
const fs = require('fs'); const path = require('path');
const SRC = path.resolve(__dirname, '..', '..', 'src');
const files = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !p.includes(`${path.sep}testing${path.sep}`) && !p.includes(`${path.sep}migrations${path.sep}`)) files.push(p); } })(SRC);
const controllerText = files.filter((f) => f.endsWith('.controller.ts')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const PRIMS = [{ name: 'numbering.getNextNumber', re: /\.getNextNumber\(/ }, { name: 'processEngine.transition', re: /(processEngine|process)\.transition\(/ }];
const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');
function callArgs(text, start) { // text from the '(' after the call name; returns top-level argument strings
  let depth = 0; let cur = ''; const args = []; let i = start;
  for (; i < text.length; i += 1) { const c = text[i]; if (c === '(' || c === '[' || c === '{') { depth += 1; if (depth === 1) continue; } else if (c === ')' || c === ']' || c === '}') { depth -= 1; if (depth === 0) { if (cur.trim()) args.push(cur.trim()); break; } } else if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue; } if (depth >= 1) cur += c; }
  return args;
}
const rows = [];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8'); const lines = text.split('\n');
  lines.forEach((ln, i) => {
    for (const pr of PRIMS) {
      const m = pr.re.exec(ln); if (!m || /^\s*(\/\/|\*)/.test(ln)) continue;
      const offset = lines.slice(0, i).join('\n').length + (i ? 1 : 0) + m.index + m[0].length - 1;
      const args = callArgs(text, offset + 1 - 1);
      const last = (args[args.length - 1] ?? '').replace(/\s+/g, ' ');
      const wantArgs = pr.name.startsWith('numbering') ? 1 : 5; // getNextNumber(type, manager?) · transition(def, entityType, id, action, actor, manager?)
      const hasManagerArg = args.length > wantArgs;
      // enclosing method: nearest preceding line that looks like a method declaration
      let method = '?'; let sig = '';
      for (let j = i; j >= 0; j -= 1) { const mm = lines[j].match(/^  (?:public |private |protected )?(?:async )?([A-Za-z0-9_]+)(?:<[^>]*>)?\(/); if (mm && !/^(if|for|while|switch|catch)$/.test(mm[1])) { method = mm[1]; sig = lines.slice(j, Math.min(lines.length, j + 14)).join(' '); break; } }
      const declaresManager = /manager\??:\s*EntityManager/.test(sig);
      let cls;
      if (!hasManagerArg) cls = 'NO-MANAGER';
      else if (/^(tx|txManager|trx|em|m|transactionManager|txm)$/.test(last)) cls = 'TX-CALLBACK';
      else if (/^(manager|externalManager)$/.test(last)) cls = 'CALLER-MANAGER';
      else cls = 'OTHER';
      const fromController = declaresManager && new RegExp(`\\.${method}\\(`).test(controllerText);
      rows.push({ primitive: pr.name, file: rel(f), line: i + 1, method, managerArg: last, class: cls, methodDeclaresManager: declaresManager, calledFromController: fromController });
    }
  });
}
const sum = {}; for (const r of rows) { const k = `${r.primitive} | ${r.class}${r.class === 'CALLER-MANAGER' ? (r.calledFromController ? ' | reachable from a controller' : ' | no direct controller caller') : ''}`; sum[k] = (sum[k] ?? 0) + 1; }
const md = ['| # | Primitive | Site | Enclosing method | Manager argument | Class | Controller-reachable (name heuristic) |', '|---|---|---|---|---|---|---|', ...rows.map((r, n) => `| ${n + 1} | ${r.primitive} | \`${r.file}:${r.line}\` | ${r.method} | \`${r.managerArg || '(none)'}\` | ${r.class} | ${r.class === 'CALLER-MANAGER' ? (r.calledFromController ? 'yes' : 'no') : '-'} |`)].join('\n');
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ summary: sum, rows }, null, 1));
if (process.argv[3]) fs.writeFileSync(process.argv[3], md + '\n');
console.log(JSON.stringify({ total: rows.length, summary: sum }, null, 1));
