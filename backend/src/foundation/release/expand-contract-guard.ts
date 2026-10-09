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

/**
 * Does the statement ADD a column that is NOT NULL **without a DEFAULT of its own**? Every `ADD [COLUMN] <definition>` of a multi-column `ALTER TABLE` is judged on
 * its OWN definition, which runs from its `ADD` to the next `ADD` (or the first `;`, or the end): one statement may legitimately mix required columns (each with its
 * DEFAULT) and optional ones, in any order. The earlier single regex looked for the DEFAULT only on the same LINE as the `ADD` it started from, but let its match run
 * across lines into a LATER column's `NOT NULL`, so a correct, fully-defaulted `ALTER TABLE` was refused depending on where its NULL columns happened to sit
 * (2026-10-09, F2/F3 migrations); and it let `ADD a INT NOT NULL, ADD b INT DEFAULT 1` through because b's DEFAULT was on a's line. Slicing by `ADD` (not by commas
 * or parentheses) also holds when the statement is still wrapped in the `await queryRunner.query(...)` call. Constraint additions (`ADD CONSTRAINT`,
 * `ADD PRIMARY KEY`, ...) are not columns and never match.
 */
export function addsRequiredColumnWithoutDefault(statement: string): boolean {
  const adds = [...statement.matchAll(/\bADD\s+/gi)];
  for (let i = 0; i < adds.length; i++) {
    const from = (adds[i].index ?? 0) + adds[i][0].length;
    const to = i + 1 < adds.length ? (adds[i + 1].index ?? statement.length) : statement.length;
    let definition = statement.slice(from, to);
    const semi = definition.indexOf(';');
    if (semi !== -1) definition = definition.slice(0, semi);
    definition = definition.replace(/^COLUMN\s+/i, '');
    if (/^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE)\b/i.test(definition)) continue;
    if (/\bNOT\s+NULL\b/i.test(definition) && !/\bDEFAULT\b/i.test(definition)) return true;
  }
  return false;
}

const CONTRACTION_PATTERNS: Array<{ re?: RegExp; test?: (statement: string) => boolean; rule: string }> = [
  { re: /\bDROP\s+COLUMN\b/i, rule: 'DROP COLUMN — the outgoing release may still read it; drop in a later delta' },
  { re: /\bDROP\s+TABLE\b/i, rule: 'DROP TABLE — the outgoing release may still read it; drop in a later delta' },
  { re: /\bALTER\s+COLUMN\s+.+\s+TYPE\b/i, rule: 'ALTER COLUMN … TYPE — not backward-compatible; add a new column + backfill instead' },
  { re: /\bALTER\s+TABLE\s+.+\s+RENAME\s+COLUMN\b/i, rule: 'RENAME COLUMN — breaks the outgoing release; add the new name, keep the old' },
  { re: /\bALTER\s+TABLE\s+.+\s+RENAME\s+TO\b/i, rule: 'RENAME TABLE — breaks the outgoing release' },
  { re: /\bALTER\s+COLUMN\s+.+\s+SET\s+NOT\s+NULL\b/i, rule: 'SET NOT NULL on an existing column — outgoing-release writes may violate it mid-swap' },
  // ADD COLUMN ... NOT NULL with no DEFAULT — judged PER COLUMN DEFINITION (see addsRequiredColumnWithoutDefault)
  { test: addsRequiredColumnWithoutDefault, rule: 'ADD COLUMN NOT NULL without DEFAULT — outgoing-release inserts omit it and fail' },
  { re: /\bDROP\s+(?:NOT\s+NULL\s+)?DEFAULT\b/i, rule: 'DROP DEFAULT — outgoing-release inserts that omit the column will fail' },
];

/**
 * `DROP CONSTRAINT "X"` is handled separately from `CONTRACTION_PATTERNS`
 * (2026-09-22, false-positive found while validating v1.1.2): Postgres has
 * no `ALTER CHECK CONSTRAINT`, so the ONLY mechanism to widen a CHECK
 * constraint's allowed-value list (a purely additive change — the outgoing
 * release's existing reads/writes are unaffected, nothing it relies on is
 * removed) is DROP the old constraint and ADD a new one under the SAME
 * name. Textually that is indistinguishable from a genuine, unsafe
 * contraction (drop with no same-name replacement, or a rename) to a
 * per-statement scan — exactly the shape `1789760000000-
 * AddTransientDatabaseErrorClosingExceptionCategory.ts` and `1789730300000-
 * AddBiometricDailySummaryImport.ts` both use, purely to widen an enum-like
 * CHECK. Both were incorrectly blocked.
 *
 * The fix scans the WHOLE `up()` body (not one statement in isolation) for
 * a `DROP CONSTRAINT "X"` that is NOT followed, anywhere later in the same
 * body, by an `ADD CONSTRAINT "X"` under that identical name — i.e. "was
 * this constraint dropped and never brought back under the same name" (a
 * real removal/rename, still flagged) vs. "redefined in place" (safe by
 * construction: whatever the outgoing release's queries validated against
 * the old CHECK, the new CHECK permits at least the same set of values —
 * the migration only ever ADDS values here, never removes any; a
 * same-name redefinition that genuinely narrowed the constraint would
 * still be a real bug, but that is a data-correctness question outside a
 * text scanner's reach, not something this guard was ever positioned to
 * catch even before this fix — see the file's own disclosed KNOWN
 * LIMITATION doc comment).
 */
const DROP_CONSTRAINT_NAME_RE = /\bDROP\s+CONSTRAINT\s+"([^"]+)"/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findUnstagedConstraintDrops(upBody: string): string[] {
  const flagged: string[] = [];
  for (const stmt of splitStatements(upBody)) {
    const m = DROP_CONSTRAINT_NAME_RE.exec(stmt);
    if (!m) continue;
    const name = m[1];
    const redefined = new RegExp(`\\bADD\\s+CONSTRAINT\\s+"${escapeRegExp(name)}"`, 'i').test(upBody);
    if (!redefined) flagged.push(stmt);
  }
  return flagged;
}

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
      for (const { re, test, rule } of CONTRACTION_PATTERNS) {
        if (re ? re.test(code) : test!(code)) {
          out.push({ file: f.path, statement: stmt.replace(/\s+/g, ' ').trim().slice(0, 240), rule });
          break; // one violation per statement is enough to flag it
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
