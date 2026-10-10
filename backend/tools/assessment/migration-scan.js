'use strict';
/**
 * TEST-03 / axis 2 — READ-ONLY static scan of src/database/migrations: counts per tag, timestamp ordering/duplicates, class/name consistency, missing or empty down(),
 * destructive statements (DROP TABLE/COLUMN, TRUNCATE, DELETE without WHERE), and use of IF [NOT] EXISTS (idempotency hint). Static only: it proves nothing about runtime behaviour.
 * Usage: node tools/assessment/migration-scan.js [outFile.json]
 */
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', 'src', 'database', 'migrations'); const rows = [];
for (const tag of fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const f of fs.readdirSync(path.join(ROOT, tag.name)).filter((n) => n.endsWith('.ts') && !n.endsWith('.spec.ts'))) {
    const t = fs.readFileSync(path.join(ROOT, tag.name, f), 'utf8'); const ts = (f.match(/^(\d{13})-/) || [])[1];
    const cls = (t.match(/export class (\w+)/) || [])[1]; const nameProp = (t.match(/name\s*=\s*'([^']+)'/) || [])[1];
    const down = t.match(/async down\([^)]*\)[^{]*\{([\s\S]*)\}\s*\}\s*$/); const downBody = down ? down[1].trim() : null;
    rows.push({ tag: tag.name, file: f, ts, cls, nameMatchesTimestamp: !!(cls && ts && cls.endsWith(ts) && (!nameProp || nameProp === cls)), hasDown: !!downBody, emptyDown: downBody !== null && !/\S/.test(downBody.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), destructive: /\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\s+[\w."]+\s*(;|`|')/i.test(t.split(/async down/)[0]), ifNotExists: /IF\s+(NOT\s+)?EXISTS/i.test(t) });
  }
}
const byTag = {}; for (const r of rows) byTag[r.tag] = (byTag[r.tag] ?? 0) + 1;
const tsCount = new Map(); for (const r of rows) tsCount.set(r.ts, (tsCount.get(r.ts) ?? 0) + 1);
const dupTs = [...tsCount.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
const result = { total: rows.length, byTag, duplicateTimestamps: dupTs, nameOrTimestampMismatch: rows.filter((r) => !r.nameMatchesTimestamp).map((r) => `${r.tag}/${r.file}`).slice(0, 30), nameMismatchCount: rows.filter((r) => !r.nameMatchesTimestamp).length,
  noDown: rows.filter((r) => !r.hasDown).length, emptyDown: rows.filter((r) => r.emptyDown).length, destructiveInUp: rows.filter((r) => r.destructive).map((r) => `${r.tag}/${r.file}`), idempotentHint: rows.filter((r) => r.ifNotExists).length };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ ...result, rows }, null, 1));
console.log(JSON.stringify(result, null, 1));
