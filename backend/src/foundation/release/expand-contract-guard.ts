/**
 * CTO-P3 / Invariant I-8 — **expand/contract migrations only**
 * (`RELEASE_ARCHITECTURE.md` §4 "Migrate LATE", `RELEASE_ENGINES_SPEC.md`
 * Piece 2). The staged deploy runs migrations immediately BEFORE the atomic
 * swap, so for a few milliseconds the OUTGOING release's code serves against
 * the NEW schema. That is only safe if every migration in the delta is
 * backward-compatible with the outgoing release: add columns/tables/indexes,
 * never drop or rename the last thing a running reader depends on, never
 * retype a column, never add a NOT NULL column without a default.
 *
 * This guard scans the `up()` body of each NEW migration file in a delta for
 * the destructive DDL shapes and, when `RELEASE_EXPAND_CONTRACT_ENFORCE` is
 * on, **blocks the deploy before the swap** (I-2 preserved — ACTIVE
 * untouched). The real fix for a flagged migration is to split it: ship the
 * additive half now, the contracting half in a LATER delta once nothing
 * reads the old shape.
 *
 * KNOWN LIMITATION (disclosed, not silently trusted — same discipline as the
 * ESLint boundary rule in `eslint.config.mjs`): this is a **textual** scan
 * of SQL string literals. It will miss contraction expressed via
 * `queryRunner.dropColumn(...)` / `queryRunner.changeColumn(...)` builder
 * calls, dynamic SQL, or SQL assembled from variables; and it can
 * false-positive on the word "DROP" inside a comment or a string. It is a
 * safety net, not a proof. The authoritative check is delta assembly by the
 * Delta Discovery Engine (spec Piece 1, deferred) + human review of every
 * migration in a release.
 */

export interface ContractionViolation {
  /** The migration file path (as it appears in the manifest). */
  file: string;
  /** The offending statement, trimmed to 240 chars. */
  statement: string;
  /** Why it is not expand/contract-safe. */
  rule: string;
}

const CONTRACTION_PATTERNS: Array<{ re: RegExp; rule: string }> = [
  { re: /\bDROP\s+COLUMN\b/i, rule: 'DROP COLUMN — the outgoing release may still read it; drop in a later delta' },
  { re: /\bDROP\s+TABLE\b/i, rule: 'DROP TABLE — the outgoing release may still read it; drop in a later delta' },
  { re: /\bALTER\s+COLUMN\s+.+\s+TYPE\b/i, rule: 'ALTER COLUMN … TYPE — not backward-compatible; add a new column + backfill instead' },
  { re: /\bALTER\s+TABLE\s+.+\s+RENAME\s+COLUMN\b/i, rule: 'RENAME COLUMN — breaks the outgoing release; add the new name, keep the old' },
  { re: /\bALTER\s+TABLE\s+.+\s+RENAME\s+TO\b/i, rule: 'RENAME TABLE — breaks the outgoing release' },
  { re: /\bALTER\s+COLUMN\s+.+\s+SET\s+NOT\s+NULL\b/i, rule: 'SET NOT NULL on an existing column — outgoing-release writes may violate it mid-swap' },
  // ADD COLUMN ... NOT NULL with no DEFAULT in the same statement
  { re: /\bADD\s+(?:COLUMN\s+)?(?!.*\bDEFAULT\b)[^;()]*\bNOT\s+NULL\b/i, rule: 'ADD COLUMN NOT NULL without DEFAULT — outgoing-release inserts omit it and fail' },
  { re: /\bDROP\s+CONSTRAINT\b/i, rule: 'DROP CONSTRAINT — may be relied on by the outgoing release; stage it' },
  { re: /\bDROP\s+(?:NOT\s+NULL\s+)?DEFAULT\b/i, rule: 'DROP DEFAULT — outgoing-release inserts that omit the column will fail' },
];

/** Everything between `up(` and the following `down(` / `private ` / end. Best-effort. */
function extractUpBody(source: string): string {
  const upIdx = source.search(/\b(?:async\s+)?up\s*\(/);
  if (upIdx === -1) return source; // not a recognisable migration — scan the whole thing
  const rest = source.slice(upIdx);
  const downIdx = rest.search(/\b(?:async\s+)?down\s*\(/);
  return downIdx === -1 ? rest : rest.slice(0, downIdx);
}

/** Split on `;` outside of quotes — good enough for the pattern scan. */
function splitStatements(body: string): string[] {
  return body
    .replace(/`([^`]*)`/g, (_m, g1: string) => g1) // unwrap template literals so multi-line SQL is one blob
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Scan the `up()` bodies of the given migration sources for contraction DDL.
 * `files` = the NEW migration files in a delta (path + full file text).
 */
export function scanForContraction(files: Array<{ path: string; source: string }>): ContractionViolation[] {
  const out: ContractionViolation[] = [];
  for (const f of files) {
    // strip comments first so `// we deliberately do NOT DROP COLUMN x` and
    // `-- keep this column` are never matched.
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
          break; // one violation per statement is enough to flag it
        }
      }
    }
  }
  return out;
}

/**
 * Does a manifest file path look like a TypeORM migration?
 * (`(src|dist)/database/migrations/<digits>-Name.(js|ts)` — with or without
 * the per-module partition tag segment introduced in ADR-025 / P6, e.g.
 * `dist/database/migrations/sales/<digits>-Name.js`).
 */
export function isMigrationPath(path: string): boolean {
  return /(?:^|\/)(?:src|dist)\/database\/migrations\/(?:[a-z][a-z0-9_-]*\/)?\d+[-_].+\.(?:js|ts)$/.test(
    path.replace(/\\/g, '/'),
  );
}
