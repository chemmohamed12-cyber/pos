import { join, resolve } from 'path';

/**
 * Release Slots topology (CTO-P3 / `RELEASE_ARCHITECTURE.md` §2,
 * `RELEASE_ENGINES_SPEC.md` Piece 2). Pure path arithmetic — no I/O, no
 * DI — so it is trivially testable and has one place that knows how a
 * slot dir is named.
 *
 * ```
 * <deployRoot>/
 *   <activeDirname>              ACTIVE     — the fixed PassengerAppRoot leaf, never moved as a path
 *   <activeDirname>.next-<id>    CANDIDATE  — built + verified before the swap  (also RELEASE_STAGING_PATH may hold it)
 *   <activeDirname>.prev-<id>    PREVIOUS   — the tree swapped out by a SUCCESSFUL deploy (rollback source)
 *   <activeDirname>.failed-<id>  FAILED     — a tree swapped out by a ROLLBACK (drill or real)
 * ```
 *
 * `activeDirname` may itself contain a `/` (e.g. `release-new/backend`,
 * or `current/api` for another app) — the suffix is appended to the
 * whole leaf, so `<deployRoot>/release-new/backend.prev-<id>`.
 */
export type ReleaseSlotKind = 'active' | 'candidate' | 'previous' | 'failed';

export interface ReleaseSlotConfig {
  /** `config.releaseDeploy.deployRoot` */
  deployRoot: string;
  /** `config.releaseDeploy.activeDirname` — relative to `deployRoot`; may contain `/`. */
  activeDirname: string;
}

const SUFFIX: Record<Exclude<ReleaseSlotKind, 'active'>, string> = {
  candidate: '.next-',
  previous: '.prev-',
  failed: '.failed-',
};

/** Absolute path of the ACTIVE slot (the live PassengerAppRoot). */
export function activeSlotPath(cfg: ReleaseSlotConfig): string {
  return resolve(join(cfg.deployRoot, cfg.activeDirname));
}

/** Absolute path of a per-release slot dir. `releaseId` is sanitized to `[A-Za-z0-9._-]`. */
export function slotPath(cfg: ReleaseSlotConfig, kind: Exclude<ReleaseSlotKind, 'active'>, releaseId: string): string {
  const safe = sanitizeReleaseId(releaseId);
  return resolve(join(cfg.deployRoot, cfg.activeDirname)) + SUFFIX[kind] + safe;
}

/** Classify a sibling dir name against the topology; returns null if it is not a slot. */
export function classifySlotName(cfg: ReleaseSlotConfig, absPath: string): { kind: Exclude<ReleaseSlotKind, 'active'>; releaseId: string } | null {
  const base = resolve(join(cfg.deployRoot, cfg.activeDirname));
  const p = resolve(absPath);
  for (const [kind, suffix] of Object.entries(SUFFIX) as Array<[Exclude<ReleaseSlotKind, 'active'>, string]>) {
    if (p.startsWith(base + suffix)) {
      return { kind, releaseId: p.slice((base + suffix).length) };
    }
  }
  return null;
}

/**
 * The two renames of the ATOMIC SWAP, as `{ from, to }` pairs to run in
 * order. Both are inside `deployRoot` → same volume → effectively
 * instantaneous, no half-written window.
 *
 * 1. ACTIVE      → PREVIOUS (`<active>.prev-<id>`)
 * 2. CANDIDATE   → ACTIVE
 */
export function atomicSwapRenames(cfg: ReleaseSlotConfig, releaseId: string, candidateAbsPath: string): Array<{ from: string; to: string }> {
  return [
    { from: activeSlotPath(cfg), to: slotPath(cfg, 'previous', releaseId) },
    { from: resolve(candidateAbsPath), to: activeSlotPath(cfg) },
  ];
}

/**
 * The reverse renames for a post-swap ROLLBACK, in order:
 * 1. ACTIVE (the rejected tree) → FAILED (`<active>.failed-<id>`)
 * 2. PREVIOUS (`<active>.prev-<id>`)                → ACTIVE
 */
export function rollbackRenames(cfg: ReleaseSlotConfig, releaseId: string): Array<{ from: string; to: string }> {
  return [
    { from: activeSlotPath(cfg), to: slotPath(cfg, 'failed', releaseId) },
    { from: slotPath(cfg, 'previous', releaseId), to: activeSlotPath(cfg) },
  ];
}

/** `RELEASE_APP_ROOT` must equal `<deployRoot>/<activeDirname>` — the deploy preflight asserts this. */
export function appRootMatchesTopology(cfg: ReleaseSlotConfig, appRoot: string): boolean {
  return resolve(appRoot) === activeSlotPath(cfg);
}

export function sanitizeReleaseId(releaseId: string): string {
  // Slot dir names are `<fixed base><suffix><id>` — `.` is dropped from the
  // allowlist so an id can never introduce a `..` or a hidden-file segment.
  const safe = releaseId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!safe || /^[-_]+$/.test(safe)) {
    throw new Error(`Unsafe release id for a slot dir name: "${releaseId}".`);
  }
  return safe;
}
