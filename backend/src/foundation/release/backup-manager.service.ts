import { Injectable, Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { mkdir, stat, rm, writeFile } from 'fs/promises';
import { dirname, basename, join, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BackupRun } from './backup-run.entity';
import { BackupArtifact } from './backup-artifact.entity';
import { BackupTrigger } from './backup-trigger';
import { BackupRunStatus } from './backup-status';
import { readAppVersion } from './app-version';
import { computeFileChecksum } from './checksum';
import { PgDumpRunnerService } from './pg-dump-runner.service';
import { AppConfigService } from '../configuration/app-config.service';
import { AuditService } from '../audit/audit.service';

const execFileAsync = promisify(execFile);
const MEDIA_ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000;
/** Retention never deletes below this many most-recent runs, regardless of age — CTO directive: "do not assume a single backup file is sufficient." */
const MIN_KEEP_RUNS = 3;

/**
 * Release Center — Phase A (Backup Foundation). Orchestrates one backup
 * event end to end: create the DB dump (`PgDumpRunnerService`), archive
 * `MEDIA_STORAGE_PATH`, checksum + verify both, record everything as
 * `BackupRun`/`BackupArtifact` rows, and audit every step.
 *
 * The two artifacts are attempted INDEPENDENTLY — a failure in one never
 * hides whether the other succeeded, so a run can end up `'completed'`,
 * `'partially_failed'`, or `'failed'`, never silently "half done" with no
 * record of which half.
 */
@Injectable()
export class BackupManagerService {
  private readonly logger = new Logger(BackupManagerService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
    private readonly pgDump: PgDumpRunnerService,
    private readonly audit: AuditService,
  ) {}

  async createBackup(trigger: BackupTrigger, initiatedByUserId: string | null): Promise<BackupRun> {
    const runRepo = this.dataSource.getRepository(BackupRun);
    const artifactRepo = this.dataSource.getRepository(BackupArtifact);

    const run = await runRepo.save(
      runRepo.create({
        trigger,
        initiatedByUserId,
        status: 'running',
        sourceAppVersion: readAppVersion(),
        completedAt: null,
        errorMessage: null,
      }),
    );

    await this.audit.record({
      actorUserId: initiatedByUserId,
      organizationId: null,
      action: 'release.backup.started',
      resource: 'backup_run',
      resourceId: run.id,
      result: 'success',
      correlationId: null,
      after: { trigger, sourceAppVersion: run.sourceAppVersion },
    });

    const { storagePath } = this.config.releaseBackup;
    await mkdir(join(storagePath, 'db'), { recursive: true });
    await mkdir(join(storagePath, 'media'), { recursive: true });

    const dbOk = await this.runDatabaseArtifact(run, artifactRepo, storagePath, initiatedByUserId);
    const mediaOutcome = await this.runMediaArtifact(run, artifactRepo, storagePath, initiatedByUserId);

    const finalStatus = this.resolveRunStatus(dbOk, mediaOutcome);
    run.status = finalStatus;
    run.completedAt = new Date();
    const saved = await runRepo.save(run);

    await this.writeBackupManifest(saved, artifactRepo, storagePath);

    await this.audit.record({
      actorUserId: initiatedByUserId,
      organizationId: null,
      action: finalStatus === 'failed' ? 'release.backup.failed' : 'release.backup.completed',
      resource: 'backup_run',
      resourceId: run.id,
      result: finalStatus === 'failed' ? 'failure' : 'success',
      correlationId: null,
      after: { status: finalStatus },
    });

    return saved;
  }

  /**
   * Backup ↔ Filesystem ↔ Manifest ↔ SHA256 linkage (v1.0.3 report §29).
   * Writes a self-contained JSON descriptor next to the artifacts at a
   * DETERMINISTIC path — `<storagePath>/manifests/<runId>.json` — so restore
   * / rollback tooling (and a human) can see, in one file, exactly what a
   * backup contains, from what version, verified how, without querying the
   * DB. A failure to write it is logged, never fails the backup (the
   * artifacts + rows are the source of truth; this is a convenience index).
   */
  private async writeBackupManifest(
    run: BackupRun,
    artifactRepo: Repository<BackupArtifact>,
    storagePath: string,
  ): Promise<void> {
    try {
      const artifacts = await artifactRepo.find({ where: { backupRunId: run.id } });
      let migrationHead: string | null = null;
      try {
        const rows: Array<{ name: string }> = await this.dataSource.query('SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1');
        migrationHead = rows[0]?.name ?? null;
      } catch {
        migrationHead = null;
      }

      const manifest = {
        schema: 'daii.backup-manifest/1',
        backupRunId: run.id,
        status: run.status,
        trigger: run.trigger,
        sourceAppVersion: run.sourceAppVersion,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        database: { name: this.config.database.database, host: this.config.database.host, migrationHead },
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        appRoots: {
          releaseAppRoot: this.config.releaseExecution.appRoot,
          frontendRuntimePath: this.config.releaseExecution.frontendRuntimePath,
          backupStoragePath: storagePath,
        },
        artifacts: artifacts.map((a) => ({
          type: a.type,
          filePath: a.filePath,
          sizeBytes: a.sizeBytes,
          sha256: a.checksumSha256,
          status: a.status,
          verifiedAt: a.verifiedAt,
        })),
      };

      const manifestPath = join(storagePath, 'manifests', `${run.id}.json`);
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    } catch (err) {
      this.logger.warn(`Could not write backup manifest for run "${run.id}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** `'skipped'`: no media directory exists yet (a fresh install with no uploads) — not a failure, nothing to back up. */
  private resolveRunStatus(dbOk: boolean, mediaOutcome: 'ok' | 'failed' | 'skipped'): BackupRunStatus {
    const mediaOk = mediaOutcome !== 'failed';
    if (dbOk && mediaOk) return 'completed';
    if (!dbOk && mediaOutcome === 'failed') return 'failed';
    return 'partially_failed';
  }

  private async runDatabaseArtifact(
    run: BackupRun,
    artifactRepo: Repository<BackupArtifact>,
    storagePath: string,
    initiatedByUserId: string | null,
  ): Promise<boolean> {
    const relativePath = join('db', `${run.id}.dump`);
    const absolutePath = join(storagePath, relativePath);
    try {
      await this.pgDump.dump(this.config.database, absolutePath);
      const artifact = await this.recordArtifact(artifactRepo, run.id, 'database', relativePath, absolutePath);
      await this.verifyArtifact(artifactRepo, artifact, absolutePath);
      return artifact.status === 'verified';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Database backup failed for run "${run.id}"`, err instanceof Error ? err.stack : message);
      await this.audit.record({
        actorUserId: initiatedByUserId,
        organizationId: null,
        action: 'release.backup.artifact_failed',
        resource: 'backup_run',
        resourceId: run.id,
        result: 'failure',
        correlationId: null,
        after: { type: 'database', error: message },
      });
      return false;
    }
  }

  private async runMediaArtifact(
    run: BackupRun,
    artifactRepo: Repository<BackupArtifact>,
    storagePath: string,
    initiatedByUserId: string | null,
  ): Promise<'ok' | 'failed' | 'skipped'> {
    const mediaSourcePath = resolve(this.config.mediaStoragePath);
    const sourceExists = await stat(mediaSourcePath)
      .then(() => true)
      .catch(() => false);
    if (!sourceExists) {
      this.logger.warn(`Media backup skipped for run "${run.id}" — "${mediaSourcePath}" does not exist yet (no uploads).`);
      return 'skipped';
    }

    const relativePath = join('media', `${run.id}.tar.gz`);
    const absolutePath = join(storagePath, relativePath);
    try {
      await execFileAsync('tar', ['-czf', absolutePath, '-C', dirname(mediaSourcePath), basename(mediaSourcePath)], {
        timeout: MEDIA_ARCHIVE_TIMEOUT_MS,
      });
      const artifact = await this.recordArtifact(artifactRepo, run.id, 'media', relativePath, absolutePath);
      await this.verifyArtifact(artifactRepo, artifact, absolutePath);
      return artifact.status === 'verified' ? 'ok' : 'failed';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Media backup failed for run "${run.id}"`, err instanceof Error ? err.stack : message);
      await this.audit.record({
        actorUserId: initiatedByUserId,
        organizationId: null,
        action: 'release.backup.artifact_failed',
        resource: 'backup_run',
        resourceId: run.id,
        result: 'failure',
        correlationId: null,
        after: { type: 'media', error: message },
      });
      return 'failed';
    }
  }

  private async recordArtifact(
    artifactRepo: Repository<BackupArtifact>,
    backupRunId: string,
    type: 'database' | 'media',
    relativePath: string,
    absolutePath: string,
  ): Promise<BackupArtifact> {
    const stats = await stat(absolutePath);
    const checksum = await computeFileChecksum(absolutePath);
    return artifactRepo.save(
      artifactRepo.create({
        backupRunId,
        type,
        filePath: relativePath,
        sizeBytes: String(stats.size),
        checksumSha256: checksum,
        status: 'completed',
        verifiedAt: null,
        errorMessage: null,
      }),
    );
  }

  /**
   * "A backup must not be considered valid simply because the file was
   * created" — re-checks existence, re-checks size against what was just
   * recorded, recomputes the checksum, and for a database artifact
   * specifically, confirms `pg_restore --list` can actually parse it.
   */
  async verifyArtifact(artifactRepo: Repository<BackupArtifact>, artifact: BackupArtifact, absolutePath: string): Promise<BackupArtifact> {
    try {
      const stats = await stat(absolutePath);
      if (String(stats.size) !== artifact.sizeBytes) {
        throw new Error(`Size mismatch: recorded ${artifact.sizeBytes}, actual ${stats.size}.`);
      }
      const recomputed = await computeFileChecksum(absolutePath);
      if (recomputed !== artifact.checksumSha256) {
        throw new Error('Checksum mismatch — file changed after it was recorded.');
      }
      if (artifact.type === 'database') {
        const structural = await this.pgDump.verifyDumpStructure(absolutePath);
        if (!structural.ok) {
          // Record the REAL reason (pg_restore's own message + the binary
          // that was used) on the artifact — not a generic string — so an
          // operator can act on it without SSH-ing in to read a log.
          throw new Error(`pg_restore --list could not parse the dump: ${structural.detail}`);
        }
      }
      artifact.status = 'verified';
      artifact.verifiedAt = new Date();
      artifact.errorMessage = null;
    } catch (err) {
      artifact.status = 'verification_failed';
      artifact.errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(`Verification failed for artifact "${artifact.id}"`, artifact.errorMessage);
    }
    return artifactRepo.save(artifact);
  }

  /** Re-runs `verifyArtifact` for an existing artifact by id — the controller's `POST /release/backups/artifacts/:artifactId/verify` entry point. */
  async reverifyArtifact(artifactId: string): Promise<BackupArtifact> {
    const artifactRepo = this.dataSource.getRepository(BackupArtifact);
    const artifact = await artifactRepo.findOneOrFail({ where: { id: artifactId } });
    const absolutePath = join(this.config.releaseBackup.storagePath, artifact.filePath);
    return this.verifyArtifact(artifactRepo, artifact, absolutePath);
  }

  /**
   * Deletes artifact files + rows older than the configured retention
   * window, but never below `MIN_KEEP_RUNS` most-recent runs regardless of
   * age — "do not assume a single backup file is sufficient" applies in
   * both directions: never zero backups, and never an unbounded pile.
   */
  async applyRetentionPolicy(): Promise<{ deletedRuns: number }> {
    const runRepo = this.dataSource.getRepository(BackupRun);
    const artifactRepo = this.dataSource.getRepository(BackupArtifact);
    const { storagePath, retentionDays } = this.config.releaseBackup;

    const allRuns = await runRepo.find({ order: { startedAt: 'DESC' } });
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const candidates = allRuns.slice(MIN_KEEP_RUNS).filter((r) => r.startedAt < cutoff);

    let deletedRuns = 0;
    for (const run of candidates) {
      const artifacts = await artifactRepo.find({ where: { backupRunId: run.id } });
      for (const artifact of artifacts) {
        await rm(join(storagePath, artifact.filePath), { force: true });
      }
      await rm(join(storagePath, 'manifests', `${run.id}.json`), { force: true });
      await artifactRepo.remove(artifacts);
      await runRepo.remove(run);
      deletedRuns++;
      await this.audit.record({
        actorUserId: null,
        organizationId: null,
        action: 'release.backup.retention_deleted',
        resource: 'backup_run',
        resourceId: run.id,
        result: 'success',
        correlationId: null,
        before: { startedAt: run.startedAt },
      });
    }

    return { deletedRuns };
  }
}
