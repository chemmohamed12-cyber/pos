import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { copyFile, cp, mkdir, rename, rm, stat, utimes, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import { Release } from './release.entity';
import { ReleaseMigrationRun } from './release-migration-run.entity';
import { PackageValidatorService, ALLOWED_PREFIXES, ALLOWED_ROOT_FILES } from './package-validator.service';
import { ReleaseManagerService } from './release-manager.service';
import { ReleaseHealthCheckService } from './release-health-check.service';
import { DeployPreflightService } from './deploy-preflight.service';
import { RestoreManagerService } from './restore-manager.service';
import { createMigrationDataSource } from './migration-datasource';
import { ReleasePackageType } from './release-status';
import { AppConfigService } from '../configuration/app-config.service';
import { AuditService } from '../audit/audit.service';

/**
 * Release Center — Execution Layer. The orchestrator for the CTO
 * directive's exact pipeline: Upload -> Preflight/Validate -> Base
 * Version Check -> Verified Backup Gate -> Deploy Files -> Run
 * Migrations -> Health Check -> Success, or STOP -> Rollback -> Verify ->
 * Audit -> Failed/Rolled Back on any failure along the way.
 *
 * IMPORTANT technical note, not glossed over: the running NestJS
 * process's own injected `DataSource` resolved its `migrations` glob ONCE
 * at boot (`DataSource.buildMetadatas()`), so it can never see migration
 * files a release deploys onto disk mid-process-lifetime. Every migration
 * operation below (`runMigrations`/`undoLastMigration`) therefore opens
 * its OWN short-lived `DataSource`, scoped to `RELEASE_APP_ROOT`'s
 * CURRENT `dist/database/migrations` contents at the moment it's called,
 * and destroys it immediately after — this is what actually lets a
 * freshly-deployed migration run in the same request, with no process
 * restart in between.
 */
@Injectable()
export class ReleaseExecutionService {
  private readonly logger = new Logger(ReleaseExecutionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
    private readonly packageValidator: PackageValidatorService,
    private readonly releaseManager: ReleaseManagerService,
    private readonly healthCheck: ReleaseHealthCheckService,
    private readonly restoreManager: RestoreManagerService,
    private readonly preflight: DeployPreflightService,
    private readonly audit: AuditService,
  ) {}

  private stagingDirFor(releaseId: string): string {
    return join(this.config.releaseExecution.stagingPath, releaseId);
  }

  private snapshotDirFor(releaseId: string): string {
    return join(this.config.releaseBackup.storagePath, 'app-snapshots', releaseId);
  }

  /** Re-checked here too (belt-and-suspenders) even though `PackageValidatorService` already enforced this on every zip entry — this method trusts staging's prior work but re-derives the destination path independently rather than reusing anything unchecked. */
  private resolveAppDestination(appRoot: string, relativePath: string): string {
    const resolvedRoot = resolve(appRoot);
    const destPath = resolve(join(appRoot, relativePath));
    const isAllowed = ALLOWED_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) || ALLOWED_ROOT_FILES.includes(relativePath);
    if (!isAllowed || (destPath !== resolvedRoot && !destPath.startsWith(resolvedRoot + sep))) {
      throw new ConflictException(`Refusing to deploy file outside allowed application paths: "${relativePath}".`);
    }
    return destPath;
  }

  /**
   * Uploads + validates + stages a release ZIP. On success, the release
   * is registered as `'validated'` (or `'validation_failed'` if the
   * manifest itself is malformed) and the staging directory is kept,
   * keyed by the new release's id, for the later `deployRelease` call. On
   * a hard package-level failure (bad zip, checksum mismatch, undeclared
   * files, path-traversal attempt, etc.) the release is still recorded as
   * `'validation_failed'` with the full reason — never silently dropped —
   * and the staging directory is removed immediately.
   */
  async uploadPackage(zipFilePath: string, packageType: ReleasePackageType, uploadedByUserId: string): Promise<Release> {
    const tempStagingDir = join(this.config.releaseExecution.stagingPath, `upload-${randomUUID()}`);
    const result = await this.packageValidator.validateAndStage(zipFilePath, tempStagingDir, packageType);

    if (!result.manifest) {
      await this.audit.record({
        actorUserId: uploadedByUserId,
        organizationId: null,
        action: 'release.upload.rejected',
        resource: 'release',
        resourceId: null,
        result: 'denied',
        correlationId: null,
        after: { packageType, errors: result.errors },
      });
      throw new ConflictException(`Package rejected: ${result.errors.join('; ')}`);
    }

    const release = await this.releaseManager.registerRelease(result.manifest, packageType, uploadedByUserId);

    if (!result.ok) {
      // Manifest shape was fine but staging-level checks failed (checksum
      // mismatch, undeclared file, path-traversal, etc.) — registerRelease
      // only re-runs the plain manifest-shape check, so force the correct
      // failed status here with the FULL error set, not just its subset.
      const releaseRepo = this.dataSource.getRepository(Release);
      release.status = 'validation_failed';
      release.errorMessage = [release.errorMessage, ...result.errors].filter(Boolean).join('; ');
      release.completedAt = new Date();
      await releaseRepo.save(release);
      return release;
    }

    // Staging succeeded — move it from its temp name to the release-id-keyed
    // location deployRelease will look for later.
    const finalStagingDir = this.stagingDirFor(release.id);
    await mkdir(dirname(finalStagingDir), { recursive: true });
    await rm(finalStagingDir, { recursive: true, force: true });
    await this.renameOrCopy(tempStagingDir, finalStagingDir);

    return release;
  }

  private async renameOrCopy(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch {
      await cp(from, to, { recursive: true });
      await rm(from, { recursive: true, force: true });
    }
  }

  /**
   * The full deploy pipeline. Stops immediately and triggers automatic
   * rollback on any failure from file-deploy onward; a gate failure (no
   * verified backup) stops before anything is touched at all.
   */
  async deployRelease(releaseId: string, actorUserId: string): Promise<Release> {
    const releaseRepo = this.dataSource.getRepository(Release);
    const release = await releaseRepo.findOne({ where: { id: releaseId } });
    if (!release) throw new NotFoundException(`Release "${releaseId}" not found.`);
    if (release.status !== 'backup_verified') {
      throw new ConflictException(`Release is "${release.status}" — only a "backup_verified" release (validated + linked to a verified backup) can be deployed.`);
    }

    // STOP condition: No Verified Backup -> No Deployment, re-checked live.
    await this.releaseManager.checkDeploymentGate(releaseId);

    const stagingDir = this.stagingDirFor(releaseId);
    const stagingExists = await stat(stagingDir)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!stagingExists) {
      throw new ConflictException('No staged package files found for this release — upload it via the ZIP upload endpoint (not the JSON-only registration endpoint) before deploying.');
    }

    // Host / environment readiness (binaries, disk, DB, staged-migration
    // hygiene) — every class of failure the v1.0.3 hand-deploy hit, turned
    // into an automated STOP before a single file is touched.
    const preflight = await this.preflight.runPreflight(stagingDir);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'release.deploy.preflight',
      resource: 'release',
      resourceId: release.id,
      result: preflight.ok ? 'success' : 'denied',
      correlationId: null,
      after: { checks: preflight.checks },
    });
    if (!preflight.ok) {
      const failed = preflight.checks.filter((c) => c.status === 'fail').map((c) => `${c.name}: ${c.detail}`);
      throw new ConflictException(`Deploy preflight failed — ${failed.join(' | ')}`);
    }

    const { appRoot } = this.config.releaseExecution;

    release.status = 'deploying';
    await releaseRepo.save(release);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'release.deploy.started',
      resource: 'release',
      resourceId: release.id,
      result: 'success',
      correlationId: null,
    });

    try {
      await this.snapshotBeforeDeploy(release, appRoot);
      await this.deployFiles(release, stagingDir, appRoot);

      release.status = 'migrating';
      await releaseRepo.save(release);
      await this.runReleaseMigrations(release, appRoot);

      release.status = 'health_checking';
      await releaseRepo.save(release);
      const health = await this.healthCheck.check();
      if (!health.ok) {
        throw new Error(`Post-deploy health check failed: ${JSON.stringify(health.detail)}`);
      }

      await this.triggerPassengerRestart(release.id, actorUserId, 'deploy');

      release.status = 'succeeded';
      release.completedAt = new Date();
      await releaseRepo.save(release);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'release.deploy.succeeded',
        resource: 'release',
        resourceId: release.id,
        result: 'success',
        correlationId: null,
      });
      return release;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Deploy failed for release "${release.id}"`, err instanceof Error ? err.stack : message);
      release.status = 'failed';
      release.errorMessage = message;
      await releaseRepo.save(release);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'release.deploy.failed',
        resource: 'release',
        resourceId: release.id,
        result: 'failure',
        correlationId: null,
        after: { error: message },
      });

      await this.rollbackRelease(releaseId, actorUserId);
      const finalRelease = await releaseRepo.findOneOrFail({ where: { id: releaseId } });
      return finalRelease;
    }
  }

  private async snapshotBeforeDeploy(release: Release, appRoot: string): Promise<void> {
    const snapshotDir = this.snapshotDirFor(release.id);
    for (const file of release.manifest.files) {
      if (file.action === 'add') continue; // rollback of an 'add' is just deleting it — nothing to snapshot.
      const liveAbsolutePath = this.resolveAppDestination(appRoot, file.path);
      const exists = await stat(liveAbsolutePath)
        .then(() => true)
        .catch(() => false);
      if (!exists) continue; // nothing live to protect yet — deploy will create/skip as appropriate.
      const snapshotPath = join(snapshotDir, file.path);
      await mkdir(dirname(snapshotPath), { recursive: true });
      await copyFile(liveAbsolutePath, snapshotPath);
    }
  }

  private async deployFiles(release: Release, stagingDir: string, appRoot: string): Promise<void> {
    for (const file of release.manifest.files) {
      const destPath = this.resolveAppDestination(appRoot, file.path);
      if (file.action === 'delete') {
        await rm(destPath, { force: true });
        continue;
      }
      const sourcePath = join(stagingDir, file.path);
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(sourcePath, destPath);
    }
  }

  private async runReleaseMigrations(release: Release, appRoot: string): Promise<void> {
    const migrationDataSource = createMigrationDataSource(appRoot, this.config.database);
    const migrationRunRepo = this.dataSource.getRepository(ReleaseMigrationRun);
    const startedAt = new Date();

    await migrationDataSource.initialize();
    let pendingNames: string[] = [];
    try {
      const executedRows: Array<{ name: string }> = await migrationDataSource.query('SELECT name FROM migrations').catch(() => []);
      const executedNames = new Set(executedRows.map((r) => r.name));
      pendingNames = migrationDataSource.migrations
        .map((m) => m.name ?? m.constructor.name)
        .filter((name) => !executedNames.has(name));

      await migrationDataSource.runMigrations();

      for (const name of pendingNames) {
        await migrationRunRepo.save(
          migrationRunRepo.create({
            releaseId: release.id,
            migrationName: name,
            startedAt,
            completedAt: new Date(),
            success: true,
            errorMessage: null,
          }),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Default TypeORM migrationsTransactionMode is "all" (one
      // transaction for the whole pending batch) — a thrown error here
      // means Postgres already rolled back the ENTIRE batch, so none of
      // `pendingNames` actually committed. Logged as failed for
      // traceability, not because we know which single one syntactically
      // threw, but because we know none of them ended up applied.
      for (const name of pendingNames) {
        await migrationRunRepo.save(
          migrationRunRepo.create({
            releaseId: release.id,
            migrationName: name,
            startedAt,
            completedAt: new Date(),
            success: false,
            errorMessage: message,
          }),
        );
      }
      throw err;
    } finally {
      await migrationDataSource.destroy();
    }
  }

  /**
   * Manual rollback trigger (also called automatically by `deployRelease`
   * on any failure). Order matters: migrations are undone FIRST, while the
   * newly-deployed migration files are still on disk (their `down()`
   * bodies must be loadable), THEN files are restored/removed. If
   * migration-undo itself fails partway, the loop stops immediately and
   * falls back to a full database restore from the SAME verified backup
   * this release was gated on — the documented "last resort" from
   * ADR-020 §6 — rather than continuing to guess.
   */
  async rollbackRelease(releaseId: string, actorUserId: string): Promise<Release> {
    const releaseRepo = this.dataSource.getRepository(Release);
    const release = await releaseRepo.findOne({ where: { id: releaseId } });
    if (!release) throw new NotFoundException(`Release "${releaseId}" not found.`);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'release.rollback.started',
      resource: 'release',
      resourceId: release.id,
      result: 'success',
      correlationId: null,
    });

    const { appRoot } = this.config.releaseExecution;
    const migrationRunRepo = this.dataSource.getRepository(ReleaseMigrationRun);
    const successfulRuns = await migrationRunRepo.find({ where: { releaseId, success: true }, order: { startedAt: 'DESC', id: 'DESC' } });

    let migrationUndoFailed = false;
    if (successfulRuns.length > 0) {
      const migrationDataSource = createMigrationDataSource(appRoot, this.config.database);
      await migrationDataSource.initialize();
      try {
        for (const run of successfulRuns) {
          await migrationDataSource.undoLastMigration();
          await this.audit.record({
            actorUserId,
            organizationId: null,
            action: 'release.rollback.migration_undone',
            resource: 'release',
            resourceId: release.id,
            result: 'success',
            correlationId: null,
            after: { migrationName: run.migrationName },
          });
        }
      } catch (err) {
        migrationUndoFailed = true;
        const message = err instanceof Error ? err.message : String(err);
        await this.audit.record({
          actorUserId,
          organizationId: null,
          action: 'release.rollback.migration_undo_failed',
          resource: 'release',
          resourceId: release.id,
          result: 'failure',
          correlationId: null,
          after: { error: message },
        });
      } finally {
        await migrationDataSource.destroy();
      }
    }

    if (migrationUndoFailed) {
      const fallbackOk = await this.fallbackFullRestore(release, actorUserId);
      if (!fallbackOk) {
        release.status = 'failed';
        release.errorMessage = 'Rollback failed: migration undo failed AND the fallback full database restore also failed. Manual intervention required.';
        await releaseRepo.save(release);
        await this.audit.record({
          actorUserId,
          organizationId: null,
          action: 'release.rollback.failed',
          resource: 'release',
          resourceId: release.id,
          result: 'failure',
          correlationId: null,
        });
        return release;
      }
    }

    try {
      await this.restoreFilesFromSnapshot(release, appRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      release.status = 'failed';
      release.errorMessage = `Rollback failed while restoring files: ${message}`;
      await releaseRepo.save(release);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'release.rollback.failed',
        resource: 'release',
        resourceId: release.id,
        result: 'failure',
        correlationId: null,
        after: { error: message },
      });
      return release;
    }

    await this.triggerPassengerRestart(release.id, actorUserId, 'rollback');

    release.status = 'rolled_back';
    release.completedAt = new Date();
    await releaseRepo.save(release);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'release.rollback.completed',
      resource: 'release',
      resourceId: release.id,
      result: 'success',
      correlationId: null,
      after: { usedFallbackFullRestore: migrationUndoFailed },
    });
    return release;
  }

  private async fallbackFullRestore(release: Release, actorUserId: string): Promise<boolean> {
    if (!release.backupRunId) return false;
    try {
      const preflight = await this.restoreManager.preflight(release.backupRunId, actorUserId);
      if (preflight.status !== 'pending_confirmation') {
        return false;
      }
      await this.restoreManager.confirmAndRestore(preflight.id, actorUserId);
      return true;
    } catch (err) {
      this.logger.error(`Fallback full restore failed for release "${release.id}"`, err instanceof Error ? err.stack : String(err));
      return false;
    }
  }

  /**
   * Passenger reloads the app when its restart file's mtime changes
   * (v1.0.3 report item 17 — the manual deploy had to `touch
   * release-new/backend/tmp/restart.txt` by hand). Creates the file (and
   * its `tmp/` dir) if missing, otherwise bumps its mtime. A failure here
   * is logged + audited but NEVER fails the deploy/rollback — the files
   * and migrations are already applied; a missed auto-restart is an
   * operator "click Restart in cPanel" follow-up, not a reason to roll back
   * a good deploy.
   */
  private async triggerPassengerRestart(releaseId: string, actorUserId: string, phase: 'deploy' | 'rollback'): Promise<void> {
    const restartFile = this.config.releaseExecution.passengerRestartFile;
    try {
      await mkdir(dirname(restartFile), { recursive: true });
      const exists = await stat(restartFile)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        const now = new Date();
        await utimes(restartFile, now, now);
      } else {
        await writeFile(restartFile, `restart requested by release ${releaseId} (${phase}) at ${new Date().toISOString()}\n`);
      }
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'release.deploy.restart_triggered',
        resource: 'release',
        resourceId: releaseId,
        result: 'success',
        correlationId: null,
        after: { phase, restartFile },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not trigger Passenger restart for release "${releaseId}" (${phase}): ${message}. Restart the app manually from cPanel → Setup Node.js App → Restart.`);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'release.deploy.restart_trigger_failed',
        resource: 'release',
        resourceId: releaseId,
        result: 'failure',
        correlationId: null,
        after: { phase, restartFile, error: message },
      });
    }
  }

  private async restoreFilesFromSnapshot(release: Release, appRoot: string): Promise<void> {
    const snapshotDir = this.snapshotDirFor(release.id);
    for (const file of release.manifest.files) {
      const liveAbsolutePath = this.resolveAppDestination(appRoot, file.path);
      if (file.action === 'add') {
        await rm(liveAbsolutePath, { force: true });
        continue;
      }
      const snapshotPath = join(snapshotDir, file.path);
      const snapshotExists = await stat(snapshotPath)
        .then(() => true)
        .catch(() => false);
      if (snapshotExists) {
        await mkdir(dirname(liveAbsolutePath), { recursive: true });
        await copyFile(snapshotPath, liveAbsolutePath);
      } else {
        // No prior snapshot means the file didn't exist before this
        // release touched it (a 'modify'/'delete' entry against a file
        // that, in fact, wasn't there) — best-effort: remove whatever the
        // deploy step left behind so the app root doesn't retain it.
        await rm(liveAbsolutePath, { force: true });
      }
    }
  }
}
