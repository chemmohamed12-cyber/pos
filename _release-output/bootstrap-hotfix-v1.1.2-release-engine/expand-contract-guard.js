"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanForContraction = scanForContraction;
exports.isMigrationPath = isMigrationPath;
const CONTRACTION_PATTERNS = [
    { re: /\bDROP\s+COLUMN\b/i, rule: 'DROP COLUMN — the outgoing release may still read it; drop in a later delta' },
    { re: /\bDROP\s+TABLE\b/i, rule: 'DROP TABLE — the outgoing release may still read it; drop in a later delta' },
    { re: /\bALTER\s+COLUMN\s+.+\s+TYPE\b/i, rule: 'ALTER COLUMN … TYPE — not backward-compatible; add a new column + backfill instead' },
    { re: /\bALTER\s+TABLE\s+.+\s+RENAME\s+COLUMN\b/i, rule: 'RENAME COLUMN — breaks the outgoing release; add the new name, keep the old' },
    { re: /\bALTER\s+TABLE\s+.+\s+RENAME\s+TO\b/i, rule: 'RENAME TABLE — breaks the outgoing release' },
    { re: /\bALTER\s+COLUMN\s+.+\s+SET\s+NOT\s+NULL\b/i, rule: 'SET NOT NULL on an existing column — outgoing-release writes may violate it mid-swap' },
    { re: /\bADD\s+(?:COLUMN\s+)?(?!.*\bDEFAULT\b)[^;()]*\bNOT\s+NULL\b/i, rule: 'ADD COLUMN NOT NULL without DEFAULT — outgoing-release inserts omit it and fail' },
    { re: /\bDROP\s+(?:NOT\s+NULL\s+)?DEFAULT\b/i, rule: 'DROP DEFAULT — outgoing-release inserts that omit the column will fail' },
];
const DROP_CONSTRAINT_NAME_RE = /\bDROP\s+CONSTRAINT\s+"([^"]+)"/i;
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function findUnstagedConstraintDrops(upBody) {
    const flagged = [];
    for (const stmt of splitStatements(upBody)) {
        const m = DROP_CONSTRAINT_NAME_RE.exec(stmt);
        if (!m)
            continue;
        const name = m[1];
        const redefined = new RegExp(`\\bADD\\s+CONSTRAINT\\s+"${escapeRegExp(name)}"`, 'i').test(upBody);
        if (!redefined)
            flagged.push(stmt);
    }
    return flagged;
}
function extractUpBody(source) {
    const upIdx = source.search(/\b(?:async\s+)?up\s*\(/);
    if (upIdx === -1)
        return source;
    const rest = source.slice(upIdx);
    const downIdx = rest.search(/\b(?:async\s+)?down\s*\(/);
    return downIdx === -1 ? rest : rest.slice(0, downIdx);
}
function splitStatements(body) {
    return body
        .replace(/`([^`]*)`/g, (_m, g1) => g1)
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim())
        .filter(Boolean);
}
function scanForContraction(files) {
    const out = [];
    for (const f of files) {
        const cleaned = f.source
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\/\/[^\n]*/g, ' ')
            .replace(/--[^\n]*/g, ' ');
        const up = extractUpBody(cleaned);
        for (const stmt of splitStatements(up)) {
            const code = stmt;
            for (const { re, rule } of CONTRACTION_PATTERNS) {
                if (re.test(code)) {
                    out.push({ file: f.path, statement: stmt.replace(/\s+/g, ' ').trim().slice(0, 240), rule });
                    break;
                }
            }
        }
        for (const stmt of findUnstagedConstraintDrops(up)) {
            out.push({
                file: f.path,
                statement: stmt.replace(/\s+/g, ' ').trim().slice(0, 240),
                rule: 'DROP CONSTRAINT — may be relied on by the outgoing release; stage it',
            });
        }
    }
    return out;
}
function isMigrationPath(path) {
    return /(?:^|\/)(?:src|dist)\/database\/migrations\/(?:[a-z][a-z0-9_-]*\/)?\d+[-_].+\.(?:js|ts)$/.test(path.replace(/\\/g, '/'));
}
//# sourceMappingURL=expand-contract-guard.js.map