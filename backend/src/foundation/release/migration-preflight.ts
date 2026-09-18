import { DataSource, MigrationExecutor } from 'typeorm';
import { createMigrationDataSource, discoverMigrationTags } from './migration-datasource';
import { checkDependenciesResolve } from './dependency-check';
import { isVersionAtLeast } from './version-compare';
import { DatabaseConfig } from '../configuration/app-config.service';
import { ReleaseManifestDatabaseRequirements, ReleaseManifestFileEntry } from './release-manifest';

/**
 * CTO Directive (Production Incident 2026-09-15 post-mortem) — Migration
 * Preflight is a MANDATORY gate, not an informational display: it must
 * produce exactly one of two decisions, never a third "proceed with
 * uncertainty" state. `blockedReasons` is the human-readable "why", but
 * `decision` alone is what `ReleaseExecutionService` acts on.
 */
export interface MigrationPreflightReport {
  /** Last migration actually recorded in the LIVE target database — read from `migrations`, never assumed. */
  current: string | null;
  /** The last migration name in the full required set for this release (by timestamp) — what the DB should look like once this release is fully activated. */
  target: string | null;
  /** Every migration this release's scope covers (already executed + pending), in timestamp order. */
  required: string[];
  /** Migrations not yet applied to the target DB, per TypeORM's OWN `MigrationExecutor.getPendingMigrations()` — never a hand-rolled diff (Production Incident 2026-09-15: a hand-rolled diff previously disagreed with reality twice, correlations 9e374dab / f3c3c8ca). */
  pending: string[];
  /** The exact order `runReleaseMigrations` will execute them in — identical to `pending` (TypeORM sorts by timestamp); a distinct field only because the CTO's report contract names it separately. */
  order: string[];
  /** The migration tag/domain directories actually in scope for this deploy (entitlement-narrowed, or every tag discovered on disk — see `discoverMigrationTags`). */
  tagsInScope: string[];
  /** A migration file this release ships whose tag directory is NOT in `tagsInScope` — the exact shape of the `accounting`-omission incident, generalized to any future tag. */
  tagDriftIssues: string[];
  /** The manifest's own build-time declared migration count disagreeing with what this Preflight independently computed from the real compiled files — a corrupted/hand-edited/stale manifest, not merely a runtime environment issue. */
  manifestDriftIssues: string[];
  /** Runtime dependencies declared in the candidate's own `package.json` that do not actually resolve from its `node_modules` (Production Incident 2026-09-15 / `decimal.js`) — computed by the SAME `checkDependenciesResolve` `StagedActivationService.verifyCandidate()` uses, never a parallel implementation. */
  dependencyIssues: string[];
  compatibility: { ok: boolean; reason: string };
  decision: 'READY_TO_ACTIVATE' | 'BLOCKED';
  blockedReasons: string[];
}

export interface MigrationPreflightInput {
  /** The already-built CANDIDATE tree. A preflight only ever reads from this and from the live DB — it never touches ACTIVE and never writes anything itself. */
  candidatePath: string;
  database: DatabaseConfig;
  nodeBin: string;
  /** The app's own live, already-connected DataSource — used ONLY to read the current migration head from the real target database. */
  liveDataSource: DataSource;
  /** Entitlement-narrowed tags, or omit to auto-discover every tag directory that exists in the candidate (see `discoverMigrationTags`) — never a hardcoded list. */
  tags?: readonly string[];
  manifestFiles: ReleaseManifestFileEntry[];
  packageType?: string;
  baseVersion?: string | null;
  /** Metadata Contract — a floor, checked regardless of packageType (unlike `baseVersion`, delta-only/exact-match). */
  minimumCompatibleVersion?: string | null;
  /** Metadata Contract — the manifest's own build-time declared migration count/requirement, cross-checked against what this Preflight independently computes below. */
  manifestDatabase?: ReleaseManifestDatabaseRequirements | null;
  currentInstalledVersion: string;
}

async function getCurrentMigrationHead(liveDataSource: DataSource): Promise<string | null> {
  try {
    const rows: Array<{ name: string }> = await liveDataSource.query('SELECT name FROM migrations ORDER BY timestamp DESC, id DESC LIMIT 1');
    return rows[0]?.name ?? null;
  } catch {
    return null;
  }
}

/** `"<timestamp>-<ClassName>.(ts|js)"` file path -> TypeORM migration `name` (`"<ClassName><timestamp>"`) — the same derivation `build-release.sh`'s manifest generator and `scanDeltaMigrations` already use. */
function migrationNameFromFilePath(path: string): string | null {
  const base = path.replace(/\.(ts|js)$/, '').split('/').pop() ?? '';
  const i = base.indexOf('-');
  if (i < 0) return null;
  return base.slice(i + 1) + base.slice(0, i);
}

/**
 * Builds the Migration Preflight report and its binary activation decision.
 * A pure(-ish) function over its explicit inputs — deliberately NOT a method
 * requiring the full `ReleaseExecutionService` DI graph, so it is directly
 * unit-testable (CTO Directive: "each stage fully tested before moving to
 * the next"). Uses ONLY the real TypeORM `MigrationExecutor` as the source
 * of truth for executed/pending state — no parallel migration-state logic.
 */
export async function buildMigrationPreflight(input: MigrationPreflightInput): Promise<MigrationPreflightReport> {
  const blockedReasons: string[] = [];

  const tagsInScope = input.tags ? [...input.tags] : discoverMigrationTags(input.candidatePath);

  // Tag/migration drift — the generalized form of the accounting-omission incident: ANY migration
  // file this release ships that the real TypeORM loader (scoped to tagsInScope) does NOT find would
  // silently never run. Deliberately name-based, not path/tag-shape-based: it doesn't matter WHY a
  // migration falls outside scope (wrong tag folder, a tag missing from tagsInScope, a naming
  // mismatch) — if the engine's own loader can't find it, that is drift, full stop. This is checked
  // below, against `required` (the real, TypeORM-loaded, tagsInScope-filtered list), not re-derived
  // from path parsing here.
  const tagDriftIssues: string[] = [];
  // A real manifest's files[] includes compiler sidecars (`.d.ts`, `.js.map`) alongside every
  // compiled migration — those are never migrations themselves and `migrationNameFromFilePath`
  // was never meant to parse them (found via a real end-to-end run against a live candidate: a
  // shipped `X.d.ts` mis-derived as class name "X.d", producing 100% false-positive drift on
  // every real package). Scope this to actual `.ts`/`.js` migration files only, excluding `.d.ts`.
  const migrationFilePaths = input.manifestFiles.filter(
    (f) => f.action !== 'delete' && /database\/migrations\//.test(f.path) && /\.(ts|js)$/.test(f.path) && !f.path.endsWith('.d.ts'),
  );

  let required: string[] = [];
  let pending: string[] = [];
  // Pass `input.tags` through AS GIVEN (possibly `undefined`), not the locally-resolved
  // `tagsInScope` — `createMigrationDataSource` already does its own disk-discovery when `tags` is
  // omitted, and every other call site in this pipeline relies on that same "omit → discover"
  // contract. `tagsInScope` (above) exists for THIS report's own fields (and the drift check has
  // already used it); it is not a second source of truth for what gets requested from the DataSource.
  const migrationDataSource = createMigrationDataSource(input.candidatePath, input.database, input.tags);
  try {
    await migrationDataSource.initialize();
    const executor = new MigrationExecutor(migrationDataSource);
    const [all, pendingMigrations] = await Promise.all([executor.getAllMigrations(), executor.getPendingMigrations()]);
    required = all.map((m) => m.name);
    pending = pendingMigrations.map((m) => m.name);

    // Cross-check: every migration FILE this release ships (by name, not just by tag) must actually
    // be loadable by the migrationDataSource we just built — a file present in the manifest but not
    // found by TypeORM's own loader (wrong tag, bad filename shape, etc.) is drift too, not silence.
    for (const f of migrationFilePaths) {
      const name = migrationNameFromFilePath(f.path);
      if (name && !required.includes(name)) {
        tagDriftIssues.push(`${f.path}: derived migration name "${name}" was not found by the migration loader for tagsInScope=[${tagsInScope.join(', ')}]`);
      }
    }
  } catch (err) {
    blockedReasons.push(`Could not compute migration state: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (migrationDataSource.isInitialized) await migrationDataSource.destroy();
  }

  const current = await getCurrentMigrationHead(input.liveDataSource);
  const target = required.length > 0 ? required[required.length - 1] : current;
  const order = pending;

  // Metadata Contract — the manifest's own DECLARED migration count (set at build time from the
  // same scan that produced `manifest.migrations`) must agree with what THIS Preflight independently
  // found. Skipped (not flagged) when the manifest predates the Metadata Contract (`manifestDatabase`
  // absent) — backward compatible, never invents an expectation the artifact never declared.
  const manifestDriftIssues: string[] = [];
  if (input.manifestDatabase) {
    if (input.manifestDatabase.migrationCount !== required.length) {
      manifestDriftIssues.push(
        `manifest declares database.migrationCount=${input.manifestDatabase.migrationCount}, but ${required.length} migration(s) were actually found for tagsInScope=[${tagsInScope.join(', ')}]`,
      );
    }
    if (input.manifestDatabase.migrationRequired !== required.length > 0) {
      manifestDriftIssues.push(
        `manifest declares database.migrationRequired=${input.manifestDatabase.migrationRequired}, but ${required.length > 0 ? 'migrations were' : 'no migrations were'} actually found`,
      );
    }
  }

  const depCheck = await checkDependenciesResolve(input.candidatePath, input.nodeBin);
  const dependencyIssues = depCheck.ok ? [] : depCheck.missing.length > 0 ? depCheck.missing : [depCheck.detail];

  const compatibilityChecks: Array<{ ok: boolean; reason: string }> = [];
  if (input.packageType === 'delta' && input.baseVersion) {
    compatibilityChecks.push(
      input.baseVersion === input.currentInstalledVersion
        ? { ok: true, reason: `baseVersion "${input.baseVersion}" matches the currently installed version` }
        : { ok: false, reason: `baseVersion "${input.baseVersion}" does not match the currently installed version "${input.currentInstalledVersion}"` },
    );
  }
  if (input.minimumCompatibleVersion) {
    compatibilityChecks.push(
      isVersionAtLeast(input.currentInstalledVersion, input.minimumCompatibleVersion)
        ? { ok: true, reason: `installed version "${input.currentInstalledVersion}" meets the minimum "${input.minimumCompatibleVersion}"` }
        : { ok: false, reason: `installed version "${input.currentInstalledVersion}" is below the required minimum "${input.minimumCompatibleVersion}"` },
    );
  }
  const compatibility =
    compatibilityChecks.length === 0
      ? { ok: true, reason: 'not a delta package, and no minimum compatible version required' }
      : compatibilityChecks.every((c) => c.ok)
        ? { ok: true, reason: compatibilityChecks.map((c) => c.reason).join('; ') }
        : { ok: false, reason: compatibilityChecks.filter((c) => !c.ok).map((c) => c.reason).join('; ') };

  if (tagDriftIssues.length > 0) blockedReasons.push(...tagDriftIssues.map((i) => `Tag/migration drift: ${i}`));
  if (manifestDriftIssues.length > 0) blockedReasons.push(...manifestDriftIssues.map((i) => `Manifest drift: ${i}`));
  if (dependencyIssues.length > 0) blockedReasons.push(`Missing runtime dependencies: ${dependencyIssues.join(', ')}`);
  if (!compatibility.ok) blockedReasons.push(`Compatibility: ${compatibility.reason}`);

  const decision: MigrationPreflightReport['decision'] = blockedReasons.length === 0 ? 'READY_TO_ACTIVATE' : 'BLOCKED';

  return { current, target, required, pending, order, tagsInScope, tagDriftIssues, manifestDriftIssues, dependencyIssues, compatibility, decision, blockedReasons };
}

/** One-line, log/audit-friendly summary — the exact 8-field shape the CTO directive asked for. */
export function formatMigrationPreflight(report: MigrationPreflightReport): string {
  return [
    `MIGRATION PREFLIGHT: ${report.decision}`,
    `CURRENT: ${report.current ?? '(none)'}`,
    `TARGET: ${report.target ?? '(none)'}`,
    `REQUIRED: ${report.required.length} migration(s)`,
    `PENDING: ${report.pending.length}${report.pending.length ? ' — ' + report.pending.join(', ') : ''}`,
    `ORDER: ${report.order.join(', ') || '(none)'}`,
    `MANIFEST DRIFT: ${report.manifestDriftIssues.length ? report.manifestDriftIssues.join(', ') : 'none'}`,
    `DEPENDENCY ISSUES: ${report.dependencyIssues.length ? report.dependencyIssues.join(', ') : 'none'}`,
    `COMPATIBILITY: ${report.compatibility.ok ? 'PASS' : 'FAIL'} — ${report.compatibility.reason}`,
    `DECISION: ${report.decision}`,
    ...(report.blockedReasons.length ? [`REASONS: ${report.blockedReasons.join(' | ')}`] : []),
  ].join('\n');
}
