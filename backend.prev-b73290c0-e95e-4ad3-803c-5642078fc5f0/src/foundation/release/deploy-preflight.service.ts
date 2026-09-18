import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { access, readdir, stat, statfs } from 'fs/promises';
import { constants as FS } from 'fs';
import { join } from 'path';
import { AppConfigService } from '../configuration/app-config.service';

export type PreflightStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface PreflightCheck {
  name: string;
  status: PreflightStatus;
  detail: string;
  /** A 'fail' on a critical check blocks the deploy; a 'fail' on a non-critical one is downgraded to 'warn'. */
  critical: boolean;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

/** Below this many free bytes on the app or backup volume, the deploy is blocked (a backup + a filesystem snapshot + an extracted package need headroom). */
const MIN_FREE_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * Release Center — Execution Layer. Host / environment readiness gate,
 * run BEFORE the "No Verified Backup -> No Deployment" gate. Turns every
 * class of failure the v1.0.3 hand-deployment hit into an automated
 * pre-check (PART 2 §5):
 *
 *  - Node / npm / pg_dump / pg_restore binaries are the CONFIGURED absolute
 *    paths and are actually executable (not "whatever is on PATH").
 *  - The app root, frontend runtime path, and Passenger restart file are
 *    real and writable.
 *  - The database is reachable and its migration head is readable.
 *  - The STAGED package's migration set uses the compiled dist datasource
 *    and contains no `*.spec` / `*.test` files.
 *  - There is enough free disk for a backup + snapshot + extraction.
 *  - The backup storage path is writable.
 *
 * `PackageValidatorService` (zip safety, checksums, manifest, base
 * version) and `ReleaseManagerService.checkDeploymentGate` (verified
 * backup) are separate and still run — this service is only the host side.
 */
@Injectable()
export class DeployPreflightService {
  private readonly logger = new Logger(DeployPreflightService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
  ) {}

  async runPreflight(stagingDir?: string): Promise<PreflightResult> {
    const checks: PreflightCheck[] = [];
    const add = (name: string, status: PreflightStatus, detail: string, critical = true) =>
      checks.push({ name, status, detail, critical });

    const { nodeBin, npmBin } = this.config.releaseBuild;
    const { pgDumpBin, pgRestoreBin, storagePath: backupPath } = this.config.releaseBackup;
    const { appRoot, frontendRuntimePath, passengerRestartFile } = this.config.releaseExecution;

    // --- 1. Binaries: configured, absolute, executable -----------------
    for (const [name, bin, crit] of [
      ['bin.node', nodeBin, true],
      ['bin.npm', npmBin, false],
      ['bin.pg_dump', pgDumpBin, true],
      ['bin.pg_restore', pgRestoreBin, true],
    ] as Array<[string, string, boolean]>) {
      if (!bin || (!bin.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(bin))) {
        add(name, crit ? 'fail' : 'warn', `"${bin}" is not an absolute path — set it explicitly (v1.0.3 report item 13/14).`, crit);
        continue;
      }
      try {
        await access(bin, FS.X_OK);
        add(name, 'pass', bin, crit);
      } catch {
        add(name, crit ? 'fail' : 'warn', `"${bin}" is not executable / not found on this host.`, crit);
      }
    }

    // --- 2. Filesystem anchors ---------------------------------------
    await this.checkDir(add, 'path.app_root', appRoot, true);
    await this.checkDir(add, 'path.frontend_runtime', frontendRuntimePath, false);
    await this.checkWritable(add, 'path.passenger_restart_parent', join(passengerRestartFile, '..'), true);
    await this.checkWritable(add, 'path.backup_storage', backupPath, true);
    // NOTE (FINAL_RECONCILIATION_REPORT R3): `main.ts` serves
    // `join(process.cwd(), 'public')` literally — equal to
    // FRONTEND_RUNTIME_PATH only while RELEASE_APP_ROOT == cwd and
    // FRONTEND_RUNTIME_PATH == <appRoot>/public (the defaults, and what
    // DEPLOYMENT_RUNBOOK §0.3 sets). Documented as an invariant in
    // DEPLOYMENT_ARCHITECTURE.md rather than enforced here.

    // --- 3. Disk headroom ------------------------------------------
    for (const [name, p] of [['disk.app', appRoot], ['disk.backup', backupPath]] as Array<[string, string]>) {
      try {
        const s = await statfs(p);
        const free = s.bavail * s.bsize;
        add(name, free >= MIN_FREE_BYTES ? 'pass' : 'fail', `${(free / 1024 / 1024).toFixed(0)} MB free (need ${MIN_FREE_BYTES / 1024 / 1024} MB).`, true);
      } catch (err) {
        add(name, 'warn', `could not stat filesystem for "${p}": ${err instanceof Error ? err.message : String(err)}`, false);
      }
    }

    // --- 4. Database --------------------------------------------
    try {
      await this.dataSource.query('SELECT 1');
      add('db.connectivity', 'pass', `${this.config.database.host}/${this.config.database.database}`, true);
      try {
        const rows: Array<{ name: string }> = await this.dataSource.query('SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1');
        add('db.migration_head', 'pass', rows[0]?.name ?? '(no migrations table rows)', false);
      } catch (err) {
        add('db.migration_head', 'warn', `could not read migrations table: ${err instanceof Error ? err.message : String(err)}`, false);
      }
    } catch (err) {
      add('db.connectivity', 'fail', err instanceof Error ? err.message : String(err), true);
    }

    // --- 5. Staged package migration hygiene ------------------------
    if (stagingDir) {
      await this.checkStagedMigrations(add, stagingDir);
    } else {
      add('package.migrations', 'skip', 'no staging dir supplied — package migration checks skipped.', false);
    }

    const failed = checks.filter((c) => c.critical && c.status === 'fail');
    // Downgrade non-critical fails to warn in the surfaced list.
    for (const c of checks) if (!c.critical && c.status === 'fail') c.status = 'warn';

    return { ok: failed.length === 0, checks };
  }

  private async checkDir(add: (n: string, s: PreflightStatus, d: string, c: boolean) => void, name: string, path: string, critical: boolean): Promise<void> {
    try {
      const s = await stat(path);
      add(name, s.isDirectory() ? 'pass' : 'fail', s.isDirectory() ? path : `${path} exists but is not a directory`, critical);
    } catch {
      add(name, critical ? 'fail' : 'warn', `${path} does not exist`, critical);
    }
  }

  private async checkWritable(add: (n: string, s: PreflightStatus, d: string, c: boolean) => void, name: string, path: string, critical: boolean): Promise<void> {
    try {
      await access(path, FS.W_OK);
      add(name, 'pass', path, critical);
    } catch {
      add(name, critical ? 'fail' : 'warn', `${path} is not writable by this process`, critical);
    }
  }

  private async checkStagedMigrations(add: (n: string, s: PreflightStatus, d: string, c: boolean) => void, stagingDir: string): Promise<void> {
    const migDir = join(stagingDir, 'dist', 'database', 'migrations');
    let entries: string[];
    try {
      // Per-module migration partitioning (ADR-025, P6): files live in
      // `migrations/<tag>/`. Collect leaf filenames from every tag subdir
      // (and, for older/flat packages, the root) so the checks below still
      // see the actual migration set.
      const rootEntries = await readdir(migDir, { withFileTypes: true });
      entries = [];
      for (const e of rootEntries) {
        if (e.isDirectory()) {
          for (const inner of await readdir(join(migDir, e.name))) entries.push(inner);
        } else {
          entries.push(e.name);
        }
      }
    } catch {
      add('package.migrations', 'skip', 'package ships no dist/database/migrations — nothing to check.', false);
      return;
    }

    const dataSourceJs = join(stagingDir, 'dist', 'database', 'data-source.js');
    try {
      await access(dataSourceJs);
      add('package.migration_datasource', 'pass', 'dist/database/data-source.js present (compiled — no ts-node on the prod path).', true);
    } catch {
      add('package.migration_datasource', 'fail', 'package touches migrations but ships no dist/database/data-source.js.', true);
    }

    const testFiles = entries.filter((f) => /\.(spec|test)\.[jt]s$/.test(f));
    add(
      'package.migrations_no_test_files',
      testFiles.length === 0 ? 'pass' : 'fail',
      testFiles.length === 0 ? `${entries.length} migration file(s), no test files` : `test file(s) inside the migration set: ${testFiles.join(', ')} (v1.0.3 report item 16).`,
      true,
    );

    const nonAnchored = entries.filter((f) => /\.js$/.test(f) && !/^[0-9]/.test(f));
    if (nonAnchored.length > 0) {
      add('package.migrations_digit_anchored', 'warn', `non-timestamped .js in migrations dir (the [0-9]* glob will skip these): ${nonAnchored.join(', ')}`, false);
    }
  }
}
