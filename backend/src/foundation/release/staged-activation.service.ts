import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { constants as FS } from 'fs';
import { dirname, join, relative } from 'path';
import { AppConfigService } from '../configuration/app-config.service';
import { ReleaseManifest } from './release-manifest';
import { activeSlotPath, atomicSwapRenames, classifySlotName, rollbackRenames, slotPath, ReleaseSlotConfig } from './release-slots';
import { checkDependenciesResolve } from './dependency-check';

const execFileAsync = promisify(execFile);

/** A local `assets/*.js|css` reference in `index.html` — the frontend-bundle-drift guard (I-5). */
const BUNDLE_REF_RE = /(?:src|href)\s*=\s*["']([^"']*\/assets\/[^"']+\.(?:js|css)[^"']*)["']/gi;

export interface CandidateVerification {
  ok: boolean;
  checks: Array<{ name: string; status: 'pass' | 'fail'; detail: string }>;
}

export class RollbackFailedSafeError extends Error {
  constructor(
    message: string,
    readonly stage: string,
  ) {
    super(message);
    this.name = 'RollbackFailedSafeError';
  }
}

/**
 * CTO-P3 — No-Partial-Release / Staged Activation (`RELEASE_ENGINES_SPEC.md`
 * Piece 2, `RELEASE_ARCHITECTURE.md` §2/§4/§5). Makes ACTIVATE **atomic**:
 * a CANDIDATE tree is built + verified in full, then promoted with **two
 * renames on the same volume** (no window where the app root is
 * half-written — Invariant I-2). A post-swap failure triggers a controlled
 * reverse-rename ROLLBACK (I-3); a rollback that itself fails →
 * **FAILED-SAFE**, never a silent continue (I-4).
 *
 * All paths come from `config.releaseDeploy.*` — no literal
 * `release-new/backend` (`RELEASE_CONFIGURATION_SPEC.md`).
 */
@Injectable()
export class StagedActivationService {
  private readonly logger = new Logger(StagedActivationService.name);

  constructor(private readonly config: AppConfigService) {}

  private slotCfg(): ReleaseSlotConfig {
    const { deployRoot, activeDirname } = this.config.releaseDeploy;
    return { deployRoot, activeDirname };
  }

  activePath(): string {
    return activeSlotPath(this.slotCfg());
  }

  candidatePath(releaseId: string): string {
    return slotPath(this.slotCfg(), 'candidate', releaseId);
  }

  /**
   * Build the CANDIDATE tree: `cp -a` the current ACTIVE (symlinks copied
   * AS symlinks — the `node_modules` symlink must NOT be dereferenced),
   * then apply the release's delta files from `stagingDir` over it.
   * Never touches ACTIVE.
   */
  async buildCandidate(releaseId: string, manifest: ReleaseManifest, stagingDir: string): Promise<string> {
    const candidate = this.candidatePath(releaseId);
    await rm(candidate, { recursive: true, force: true });
    await mkdir(dirname(candidate), { recursive: true });

    // cp -a equivalent: preserve symlinks (dereference:false is the default), timestamps, mode.
    await cp(this.activePath(), candidate, { recursive: true, dereference: false, preserveTimestamps: true, force: true });

    for (const file of manifest.files) {
      const dest = join(candidate, file.path);
      if (file.action === 'delete') {
        await rm(dest, { force: true });
        continue;
      }
      const src = join(stagingDir, file.path);
      await mkdir(dirname(dest), { recursive: true });
      await cp(src, dest, { force: true });
    }

    // Root-cause fix (2026-09-21 incident): `generate_manifest()`
    // (`build-release.sh`) only ever scans `src/ dist/ public/` for
    // `manifest.files[]` — `package.json`/`package-lock.json` at the
    // package ROOT are never listed as delta files, for a `full`
    // package or a `delta` one. The loop above therefore never touches
    // them, and the CANDIDATE silently kept ACTIVE's own OLD
    // `package.json` (`dependencies`, `devDependencies`, everything but
    // the `version` string `stampVersion` below already patched) no
    // matter what the uploaded package's own `package.json` actually
    // declared. A dependency-classification fix (`@types/yauzl` moved
    // to `devDependencies`, v1.1.1) could never take effect through
    // this path: every re-upload kept re-checking whatever
    // `dependencies` ACTIVE happened to have at that moment, not the
    // candidate's own. `build-release.sh`'s own `assemble_staged()`
    // unconditionally copies both files into `stagingDir` for EVERY
    // package type (confirmed by direct reading), so copying them here
    // — unconditionally, always overwriting whatever the ACTIVE-tree
    // copy above put in their place — is correct for both `full` and
    // `delta` candidates, not just this specific fix.
    for (const rootFile of ['package.json', 'package-lock.json']) {
      const src = join(stagingDir, rootFile);
      if (await exists(src)) {
        await cp(src, join(candidate, rootFile), { force: true });
      }
    }

    // FU-1 (ERP Foundation P6 T3): defensive fallback only now — the copy
    // above already gives the candidate its own real `package.json`
    // (version included), so this is a no-op in the normal case. Kept for
    // the frontend/public trees, whose own package.json (if any) is a
    // different file the copy above does not touch, and as a safety net
    // if `stagingDir` ever lacks a root `package.json` (a malformed or
    // hand-built package, not one `build-release.sh` itself produced).
    await this.stampVersion(candidate, manifest.version);
    for (const dir of [join(candidate, '..', 'frontend'), join(candidate, 'frontend'), join(candidate, 'public')]) {
      await this.stampVersion(dir, manifest.version, true);
    }

    this.logger.log(`CANDIDATE built for release ${releaseId}: ${candidate} (${manifest.files.length} delta file(s))`);
    return candidate;
  }

  /** Rewrite `<dir>/package.json`'s `version` to `version` if it differs. `quietIfMissing` skips a dir that has no package.json. */
  private async stampVersion(dir: string, version: string, quietIfMissing = false): Promise<void> {
    const pkgPath = join(dir, 'package.json');
    let raw: string;
    try {
      raw = await readFile(pkgPath, 'utf8');
    } catch {
      if (quietIfMissing) return;
      this.logger.warn(`FU-1: no package.json at ${pkgPath} to stamp — skipped`);
      return;
    }
    try {
      const pkg = JSON.parse(raw) as { version?: string };
      if (pkg.version === version) return;
      const prev = pkg.version;
      pkg.version = version;
      // preserve trailing newline convention
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + (raw.endsWith('\n') ? '\n' : ''), 'utf8');
      this.logger.log(`FU-1: stamped ${pkgPath} version ${prev ?? '(none)'} → ${version}`);
    } catch (e) {
      this.logger.warn(`FU-1: could not stamp ${pkgPath}: ${(e as Error).message}`);
    }
  }

  /**
   * Verify the CANDIDATE in full BEFORE any swap:
   *  - structure: `dist/main.js` + `package.json` present
   *  - `node --check` every compiled `.js` under `dist/`
   *  - frontend bundle: every `assets/*` referenced by `public/index.html` exists
   *  - `require('@nestjs/core')` from the tree — proves the `node_modules` symlink still resolves
   *  - EVERY `dependencies` entry in the candidate's own `package.json` actually resolves from its
   *    `node_modules` (Production Incident 2026-09-15, root-caused: `decimal.js` was correctly
   *    declared in `package.json`/`package-lock.json` and shipped in the release artifact, but the
   *    "shared nodevenv" contract — `buildCandidate` copies ACTIVE's `node_modules` as-is, never
   *    reinstalling — meant it had never actually been installed on the target since the dependency
   *    was added, and the app crashed on boot with `MODULE_NOT_FOUND` in `dist/domains/accounting/
   *    domain/money.js`. The Invariant I-9 guard meant to catch exactly this class of problem
   *    (`ReleaseExecutionService` checking `manifest.dependencyChanges`) is dead code — nothing in
   *    this pipeline, `build-release.sh` included, ever computes/populates that field, on a `full`
   *    OR a `delta` package. This check does not depend on any manifest diff ever being computed
   *    correctly — it directly proves the candidate can satisfy its own declared dependencies,
   *    unconditionally, before the swap (I-2: a failure here leaves ACTIVE bit-for-bit untouched).
   */
  async verifyCandidate(candidatePath: string): Promise<CandidateVerification> {
    const checks: CandidateVerification['checks'] = [];
    const add = (name: string, ok: boolean, detail: string) => checks.push({ name, status: ok ? 'pass' : 'fail', detail });
    const nodeBin = this.config.releaseBuild.nodeBin;

    // 1. structure
    const mainJs = join(candidatePath, 'dist', 'main.js');
    const pkgJson = join(candidatePath, 'package.json');
    add('structure', (await exists(mainJs)) && (await exists(pkgJson)), `${mainJs} + ${pkgJson}`);

    // 2. node --check every dist .js
    const distDir = join(candidatePath, 'dist');
    let jsFiles: string[] = [];
    try {
      jsFiles = await listJsFiles(distDir);
    } catch {
      /* dist checked above */
    }
    let bad = 0;
    for (const f of jsFiles) {
      try {
        await execFileAsync(nodeBin, ['--check', f], { timeout: 15_000 });
      } catch {
        bad++;
      }
    }
    add('dist_syntax', bad === 0, `${jsFiles.length} dist .js checked, ${bad} bad`);

    // 3. frontend bundle consistency
    const publicDir = join(candidatePath, 'public');
    const indexHtml = join(publicDir, 'index.html');
    if (await exists(indexHtml)) {
      const html = await readFile(indexHtml, 'utf8');
      const refs = new Set<string>();
      let m: RegExpExecArray | null;
      BUNDLE_REF_RE.lastIndex = 0;
      while ((m = BUNDLE_REF_RE.exec(html)) !== null) {
        // m[1] is like `/assets/index-abc.js` or `assets/index-abc.css?v=1`
        const withoutQuery = m[1].split(/[?#]/)[0];
        const relToPublic = withoutQuery.replace(/^\//, '').replace(/^public\//, '');
        refs.add(relToPublic);
      }
      const missing: string[] = [];
      for (const r of refs) {
        if (!(await exists(join(publicDir, r)))) missing.push(r);
      }
      add('frontend_bundle', missing.length === 0, missing.length === 0 ? `${refs.size} asset ref(s) resolve` : `missing: ${missing.join(', ')}`);
    } else {
      add('frontend_bundle', true, 'no public/index.html (backend-only tree)');
    }

    // 4. node_modules symlink resolves from the CANDIDATE tree
    try {
      await execFileAsync(nodeBin, ['-e', "require.resolve('@nestjs/core')"], { cwd: candidatePath, timeout: 15_000 });
      add('node_modules_symlink', true, "require.resolve('@nestjs/core') from the candidate tree");
    } catch (err) {
      add('node_modules_symlink', false, `require.resolve('@nestjs/core') failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. every declared runtime dependency resolves — see this method's own doc comment
    // (Production Incident 2026-09-15 / decimal.js). Independent of check 4 above: that one proves
    // the node_modules SYMLINK itself resolves at all; this one proves every package the app actually
    // NEEDS is present inside it, not just that the well-known @nestjs/core happens to be.
    // Delegates to `checkDependenciesResolve` (dependency-check.ts) — the SAME function the Migration
    // Preflight uses, per the CTO's explicit "never a parallel implementation" instruction.
    const depCheck = await checkDependenciesResolve(candidatePath, nodeBin);
    add('dependencies_resolve', depCheck.ok, depCheck.detail);

    const ok = checks.every((c) => c.status === 'pass');
    return { ok, checks };
  }

  /** SHA-independent quick check that ACTIVE is intact — used by I-2 assertions and rollback verification. */
  async activeIsIntact(): Promise<boolean> {
    return (await exists(join(this.activePath(), 'dist', 'main.js'))) && (await exists(join(this.activePath(), 'package.json')));
  }

  /**
   * ATOMIC SWAP — two renames inside `deployRoot` (same volume):
   *   ACTIVE     → `<active>.prev-<id>`  (PREVIOUS)
   *   CANDIDATE  → ACTIVE
   * If the first rename succeeded and the second fails, the first is
   * reversed before throwing — ACTIVE is never left missing.
   */
  async activate(releaseId: string, candidatePath: string): Promise<{ previousPath: string; activePath: string }> {
    const [toPrev, toActive] = atomicSwapRenames(this.slotCfg(), releaseId, candidatePath);
    await rename(toPrev.from, toPrev.to);
    try {
      await rename(toActive.from, toActive.to);
    } catch (err) {
      // undo step 1 so ACTIVE exists again
      await rename(toPrev.to, toPrev.from).catch(() => undefined);
      throw new Error(`ATOMIC SWAP failed on CANDIDATE→ACTIVE: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.logger.log(`ATOMIC SWAP done for ${releaseId}: PREVIOUS=${toPrev.to}, ACTIVE=${this.activePath()}`);
    return { previousPath: toPrev.to, activePath: this.activePath() };
  }

  /**
   * Post-swap ROLLBACK — reverse renames:
   *   ACTIVE (the rejected tree)   → `<active>.failed-<id>`  (FAILED)
   *   `<active>.prev-<id>`         → ACTIVE
   * A failure here is a **FAILED-SAFE** condition (I-4) — thrown as
   * `RollbackFailedSafeError`; the caller must STOP + alarm, never continue.
   */
  async rollbackSwap(releaseId: string): Promise<{ failedPath: string; activePath: string }> {
    const [toFailed, toActive] = rollbackRenames(this.slotCfg(), releaseId);
    try {
      await rename(toFailed.from, toFailed.to);
    } catch (err) {
      throw new RollbackFailedSafeError(`reverse rename ACTIVE→FAILED failed: ${err instanceof Error ? err.message : String(err)}`, 'active_to_failed');
    }
    try {
      await rename(toActive.from, toActive.to);
    } catch (err) {
      throw new RollbackFailedSafeError(
        `reverse rename PREVIOUS→ACTIVE failed after ACTIVE was moved to FAILED — the app root is now MISSING: ${err instanceof Error ? err.message : String(err)}`,
        'previous_to_active',
      );
    }
    this.logger.warn(`ROLLBACK swap done for ${releaseId}: FAILED=${toFailed.to}, ACTIVE restored from PREVIOUS`);
    return { failedPath: toFailed.to, activePath: this.activePath() };
  }

  /**
   * Prune PREVIOUS / FAILED slots beyond `RELEASE_SLOT_RETENTION` (default
   * 1 of each), keeping the newest. Never touches ACTIVE or the slot(s)
   * belonging to `keepReleaseIds`. Run at COMMIT.
   */
  async pruneSlots(keepReleaseIds: string[] = []): Promise<{ pruned: string[] }> {
    const { slotRetention } = this.config.releaseDeploy;
    const cfg = this.slotCfg();
    // The sibling slots live in the SAME directory as ACTIVE (`activeDirname`
    // may itself contain a `/`, e.g. `release-new/backend`), not necessarily
    // directly under `deployRoot`.
    const slotDir = dirname(this.activePath());
    let entries: string[];
    try {
      entries = await readdir(slotDir);
    } catch {
      return { pruned: [] };
    }
    const byKind: Record<'previous' | 'failed', Array<{ path: string; releaseId: string; mtime: number }>> = { previous: [], failed: [] };
    for (const name of entries) {
      const abs = join(slotDir, name);
      const c = classifySlotName(cfg, abs);
      if (!c || c.kind === 'candidate') continue;
      let mtime = 0;
      try {
        mtime = (await stat(abs)).mtimeMs;
      } catch {
        continue;
      }
      byKind[c.kind].push({ path: abs, releaseId: c.releaseId, mtime });
    }
    const pruned: string[] = [];
    for (const kind of ['previous', 'failed'] as const) {
      // always keep slots that belong to a kept release; from the rest keep the newest `slotRetention`.
      const kept = byKind[kind].filter((s) => keepReleaseIds.includes(s.releaseId));
      const rest = byKind[kind].filter((s) => !keepReleaseIds.includes(s.releaseId)).sort((a, b) => b.mtime - a.mtime);
      for (const stale of rest.slice(Math.max(0, slotRetention - kept.length))) {
        await rm(stale.path, { recursive: true, force: true });
        pruned.push(relative(slotDir, stale.path));
      }
    }
    if (pruned.length) this.logger.log(`Pruned ${pruned.length} old slot(s): ${pruned.join(', ')}`);
    return { pruned };
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function listJsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    const ents = await readdir(d, { withFileTypes: true });
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
    }
  };
  await walk(dir);
  return out;
}
