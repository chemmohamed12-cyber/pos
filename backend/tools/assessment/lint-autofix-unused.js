'use strict';
/**
 * R2 helper — mechanical, behaviour-neutral clean-up of the ESLint `@typescript-eslint/no-unused-vars` findings, driven by an ESLint JSON report:
 *   - an unused import specifier is removed (and the whole import line when it was the only one);
 *   - an unused function PARAMETER (message "Allowed unused args must match /^_/") is renamed with a leading underscore — the signature, arity and callers are unchanged;
 *   - everything else (unused locals, other rules) is printed for manual handling.
 * Files listed after `--skip` (carrying uncommitted work of other tracks) are never touched. Usage:
 *   node tools/assessment/lint-autofix-unused.js <eslint-report.json> [--skip file1 file2 …]
 */
const fs = require('fs'); const path = require('path');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const skipAt = process.argv.indexOf('--skip'); const skip = new Set(skipAt >= 0 ? process.argv.slice(skipAt + 1) : []);
const BACKEND = path.resolve(__dirname, '..', '..');
let removedImports = 0; let renamedParams = 0; const manual = [];
for (const f of report) {
  const rel = path.relative(BACKEND, f.filePath).split(path.sep).join('/');
  const msgs = f.messages.filter((m) => m.ruleId === '@typescript-eslint/no-unused-vars');
  if (!msgs.length) { for (const m of f.messages) if (m.ruleId !== 'no-restricted-imports') manual.push(`${rel}:${m.line} ${m.ruleId}`); continue; }
  for (const m of f.messages) if (m.ruleId !== '@typescript-eslint/no-unused-vars' && m.ruleId !== 'no-restricted-imports') manual.push(`${rel}:${m.line} ${m.ruleId}`);
  if (skip.has(rel)) { manual.push(`${rel}: SKIPPED (uncommitted work of another track) — ${msgs.length} finding(s)`); continue; }
  let text = fs.readFileSync(f.filePath, 'utf8'); const crlf = text.includes('\r\n'); text = text.replace(/\r\n/g, '\n');
  const lineStarts = [0]; for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
  const off = (line, col) => lineStarts[line - 1] + col - 1;
  const edits = [];
  for (const m of msgs) {
    const start = off(m.line, m.column); const end = off(m.endLine, m.endColumn); const name = text.slice(start, end);
    if (/Allowed unused args/.test(m.message)) { edits.push({ start, end, text: `_${name}`, kind: 'param' }); continue; }
    if (/is defined but never used/.test(m.message)) {
      // is it inside an import statement?
      const stmtStart = text.lastIndexOf('\nimport ', start) + 1; const stmtEnd = text.indexOf(';', start);
      const stmt = stmtStart > 0 && stmtEnd > start ? text.slice(stmtStart, stmtEnd + 1) : '';
      if (stmt.startsWith('import ') && !stmt.includes('\nimport ') && /\{[^}]*\}/.test(stmt) && stmtStart <= start) {
        const open = text.indexOf('{', stmtStart); const close = text.indexOf('}', start);
        const names = text.slice(open + 1, close).split(',').map((s) => s.trim()).filter(Boolean);
        const keep = names.filter((n) => n.split(/\s+as\s+/).pop() !== name);
        if (keep.length === 0 && !/^import\s+[A-Za-z_$]/.test(stmt)) edits.push({ start: stmtStart, end: stmtEnd + 2 > text.length ? text.length : stmtEnd + 2, text: '', kind: 'import-line' });
        else edits.push({ start: open + 1, end: close, text: ` ${keep.join(', ')} `, kind: 'import-specifier' });
        continue;
      }
    }
    manual.push(`${rel}:${m.line} ${m.message.slice(0, 70)}`);
  }
  // apply from the end; skip overlapping edits (several specifiers of one import are merged: the last write wins, so re-run until clean)
  edits.sort((a, b) => b.start - a.start); let lastStart = Infinity;
  for (const e of edits) { if (e.end > lastStart) continue; text = text.slice(0, e.start) + e.text + text.slice(e.end); lastStart = e.start; if (e.kind === 'param') renamedParams += 1; else removedImports += 1; }
  fs.writeFileSync(f.filePath, crlf ? text.replace(/\n/g, '\r\n') : text);
}
console.log(`import edits: ${removedImports}, parameters renamed: ${renamedParams}`);
console.log('for manual handling / skipped:\n' + manual.map((x) => '  ' + x).join('\n'));
