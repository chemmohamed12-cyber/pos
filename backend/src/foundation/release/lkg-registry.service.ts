import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../configuration/app-config.service';

/**
 * CTO-P1 — Last Known Good registry (`RELEASE_ENGINES_SPEC.md` Piece 3,
 * CTO §7). `<RELEASE_MANIFESTS_PATH>/LAST_KNOWN_GOOD.json` is a
 * filesystem-visible **pointer + bounded history stack** — no `releases`
 * table column, no migration (rev-3 Q1: file-only).
 *
 * The invariant it exists for (I-6): the server always knows which release
 * is the verified fallback, and a rollback selects it **without guesswork**.
 * Written ONLY at COMMIT and on an explicit post-COMMIT rollback (the "pop"
 * rule). Never mid-transaction — a pre-COMMIT abort leaves the file
 * byte-unchanged.
 */
export interface LkgEntry {
  release_id: string;
  version: string;
  delta_id: string | null;
  activated_at: string;
  backup_run_id: string | null;
  /** Absolute path to the PREVIOUS slot that would be renamed back on rollback; `null` when nothing is physically behind ACTIVE. */
  prev_runtime_dir: string | null;
  migration_head: string | null;
  build_tag: string | null;
  verification: Record<string, unknown>;
}

export interface LkgFile {
  current: LkgEntry;
  /** Up to `RELEASE_LKG_HISTORY_DEPTH` prior `current` entries, newest first. */
  history: LkgEntry[];
}

@Injectable()
export class LkgRegistryService {
  private readonly logger = new Logger(LkgRegistryService.name);

  constructor(private readonly config: AppConfigService) {}

  private filePath(): string {
    return join(this.config.releaseDeploy.manifestsPath, 'LAST_KNOWN_GOOD.json');
  }

  /** Returns the parsed file, or `null` if it has never been seeded. */
  async read(): Promise<LkgFile | null> {
    try {
      const raw = await readFile(this.filePath(), 'utf8');
      const parsed = JSON.parse(raw) as LkgFile;
      if (!parsed || typeof parsed !== 'object' || !parsed.current) return null;
      if (!Array.isArray(parsed.history)) parsed.history = [];
      return parsed;
    } catch {
      return null;
    }
  }

  /** True once `seed()`/`commit()` has written a valid file. */
  async isSeeded(): Promise<boolean> {
    return (await this.read()) !== null;
  }

  /**
   * First-run bootstrap (engine install). The current release was
   * hand-deployed — there is no PREVIOUS slot and no LKG file. Idempotent:
   * a no-op if the file already exists.
   */
  async seed(input: {
    releaseId: string;
    version: string;
    backupRunId: string | null;
    migrationHead: string | null;
    buildTag?: string | null;
    note?: string;
  }): Promise<LkgFile> {
    const existing = await this.read();
    if (existing) return existing;
    const file: LkgFile = {
      current: {
        release_id: input.releaseId,
        version: input.version,
        delta_id: null,
        activated_at: new Date().toISOString(),
        backup_run_id: input.backupRunId,
        prev_runtime_dir: null,
        migration_head: input.migrationHead,
        build_tag: input.buildTag ?? null,
        verification: {
          seeded: true,
          note: input.note ?? 'hand-deployed baseline; rollback of the FIRST engine-driven deploy falls through to a full backup restore',
        },
      },
      history: [],
    };
    await this.write(file);
    this.logger.log(`LKG seeded: current = ${file.current.release_id} (${file.current.version}), history = []`);
    return file;
  }

  /**
   * COMMIT of a successful deploy of release N:
   * `history.unshift(current)` (truncated to the configured depth),
   * `current = <the new entry>`.
   */
  async commit(entry: LkgEntry): Promise<LkgFile> {
    const depth = this.config.releaseDeploy.lkgHistoryDepth;
    const prior = await this.read();
    const history = prior ? [prior.current, ...prior.history].slice(0, depth) : [];
    const file: LkgFile = { current: entry, history };
    await this.write(file);
    this.logger.log(`LKG commit: current = ${entry.release_id} (${entry.version}); history depth ${history.length}`);
    return file;
  }

  /**
   * Pop-on-rollback (rev-3 / CTO Q6): an explicit post-COMMIT rollback of
   * the current LKG (release N). A rolled-back release is **not** a Last
   * Known Good — it must not remain `current`.
   *
   * `current = history.shift()` (the prior LKG, N-1) with:
   *  - `prev_runtime_dir: null` (N-1's own PREVIOUS slot was pruned at N's COMMIT),
   *  - `verification.reverted_from = N`, `verification.reverted_at = now`.
   *
   * If `history` is empty (rolling back the first engine deploy, or history
   * exhausted): synthesize `current` from the pre-deploy verified backup.
   */
  async popOnRollback(input: { revertedReleaseId: string; preDeployBackupRunId: string | null; version: string; migrationHead: string | null }): Promise<LkgFile> {
    const prior = await this.read();
    const now = new Date().toISOString();

    if (prior && prior.history.length > 0) {
      const [restored, ...rest] = prior.history;
      const current: LkgEntry = {
        ...restored,
        prev_runtime_dir: null,
        verification: { ...restored.verification, reverted_from: input.revertedReleaseId, reverted_at: now },
      };
      const file: LkgFile = { current, history: rest };
      await this.write(file);
      this.logger.log(`LKG pop-on-rollback: reverted ${input.revertedReleaseId} → current = ${current.release_id}; history depth ${rest.length}`);
      return file;
    }

    // history empty → synthesize from the pre-deploy backup
    const current: LkgEntry = {
      release_id: `${input.revertedReleaseId}-reverted`,
      version: prior?.current.version ?? input.version,
      delta_id: null,
      activated_at: now,
      backup_run_id: input.preDeployBackupRunId,
      prev_runtime_dir: null,
      migration_head: input.migrationHead,
      build_tag: null,
      verification: {
        reconstructed: true,
        reverted_from: input.revertedReleaseId,
        reverted_at: now,
        note: 'fallback = full backup restore; next deploy re-establishes the chain',
      },
    };
    const file: LkgFile = { current, history: [] };
    await this.write(file);
    this.logger.warn(`LKG pop-on-rollback (empty history): synthesized current = ${current.release_id} from backup ${input.preDeployBackupRunId ?? '<none>'}`);
    return file;
  }

  /** Atomic write: temp file in the same dir, then rename. */
  private async write(file: LkgFile): Promise<void> {
    const target = this.filePath();
    await mkdir(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.LAST_KNOWN_GOOD.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
    await rename(tmp, target);
  }
}
