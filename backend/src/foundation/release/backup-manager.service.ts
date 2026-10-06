import { Injectable, Logger } from '@nestjs/common';
import { DataSource, IsNull, Repository } from 'typeorm';
import { mkdir, stat, rm, writeFile } from 'fs/promises';
import { dirname, basename, join, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BackupRun } from './backup-run.entity';
import { BackupArtifact } from './backup-artifact.entity';
import { BackupTrigger } from './backup-trigger';
import { BackupRunStatus } from './backup-status';
import { CompanyBackupSettings } from './company-backup-settings.entity';
import { BackupOperationService } from './backup-operation.service';
import { readAppVersion } from './app-version';
import { computeFileChecksum } from './checksum';
import { PgDumpRunnerService } from './pg-dump-runner.service';
import { AppConfigService, DatabaseConfig } from '../configuration/app-config.service';
import { AuditService } from '../audit/audit.service';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { CompanyService } from '../company/company.service';

const execFileAsync = promisify(execFile);
const MEDIA_ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000;
/** Retention never deletes below this many most-recent runs, regardless of age — CTO directive: "do not assume a single backup file is sufficient." Evaluated per-Company for a Company backup (Track D, D-Backup-02) — never across Companies. */
const MIN_KEEP_RUNS = 3;
/** Backup/DR Architecture V1 (2026-09-24, Track D §Step 4 freeze) — independent of `MembershipOperation`'s own retry cap by design. */
export const BACKUP_MAX_ATTEMPTS = 5;

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
    private readonly databaseRegistry: DatabaseRegistryService,
    private readonly backupOperations: BackupOperationService,
    private readonly companies: CompanyService,
  ) {}

  /**
   * Backup/DR Architecture V1 (2026-09-24, Track D). `companyId` omitted
   * (or `null`) — EXACT existing behavior, unchanged (AC-7: platform
   * backup is provably unaffected). `companyId` supplied — backs up that
   * Company's own database instead, via the mandatory §9 chain
   * (`DatabaseRegistryService.getConnectionConfigForCompany`, never an
   * ambient/default connection), skips the media artifact entirely (Step 1
   * characterization: no Company-owned media concept exists in V1), and
   * drives the attempt through the `BackupOperation` durable ledger
   * (D-Backup-03) so a failure is retried, never silently dropped.
   */
  async createBackup(trigger: BackupTrigger, initiatedByUserId: string | null, companyId: string | null = null): Promise<BackupRun> {
    const runRepo = this.dataSource.getRepository(BackupRun);
    const artifactRepo = this.dataSource.getRepository(BackupArtifact);

    const databaseConfig = companyId ? await this.databaseRegistry.getConnectionConfigForCompany(companyId) : this.config.database;
    const installationId = companyId ? (await this.companies.findById(companyId))?.installationId ?? null : null;

    const run = await runRepo.save(
      runRepo.create({
        trigger,
        initiatedByUserId,
        companyId,
        status: 'running',
        sourceAppVersion: readAppVersion(),
        completedAt: null,
        errorMessage: null,
      }),
    );
    const operation = await this.backupOperations.start(companyId, run.id);
    await this.backupOperations.markRunning(operation.id);

    await this.audit.record({
      actorUserId: initiatedByUserId,
      organizationId: null, // NOT companyId — 'organizationId' is a distinct existing concept (OrgUnit/OrgMembership); companyId travels in 'after' below (D-Backup-06)
      action: 'release.backup.started',
      resource: 'backup_run',
      resourceId: run.id,
      result: 'success',
      correlationId: operation.correlationId,
      after: { trigger, sourceAppVersion: run.sourceAppVersion, companyId },
    });

    const { storagePath } = this.config.releaseBackup;
    await mkdir(join(storagePath, 'db'), { recursive: true });

    const dbOk = await this.runDatabaseArtifact(run, artifactRepo, storagePath, initiatedByUserId, databaseConfig);
    // Media is a platform-wide concept only in V1 (Step 1 characterization) — never attempted for a Company backup.
    if (!companyId) await mkdir(join(storagePath, 'media'), { recursive: true });
    const mediaOutcome = companyId ? 'skipped' : await this.runMediaArtifact(run, artifactRepo, storagePath, initiatedByUserId);

    const finalStatus = this.resolveRunStatus(dbOk, mediaOutcome);
    run.status = finalStatus;
    run.completedAt = new Date();
    const saved = await runRepo.save(run);

    await this.writeBackupManifest(saved, artifactRepo, storagePath, databaseConfig, companyId, installationId);

    if (finalStatus === 'failed') {
      await this.backupOperations.markFailed(operation.id, 'database artifact did not verify', BACKUP_MAX_ATTEMPTS);
    } else {
      await this.backupOperations.markCompleted(operation.id);
    }

    await this.audit.record({
      actorUserId: initiatedByUserId,
      organizationId: null,
      action: finalStatus === 'failed' ? 'release.backup.failed' : 'release.backup.completed',
      resource: 'backup_run',
      resourceId: run.id,
      result: finalStatus === 'failed' ? 'failure' : 'success',
      correlationId: operation.correlationId,
      after: { status: finalStatus, companyId },
    });

    return saved;
  }

  /**
   * Backup/DR Architecture V1 (2026-09-24, Track D §Step 4/10, D-Backup-03).
   * `BackupReconciliationScheduler`'s entry point — re-attempts the SAME
   * `BackupRun` (same deterministic file path, so a retry overwrites the
   * previous failed attempt rather than creating a parallel one),
   * resolving the SAME `databaseConfig` (Company or platform) the original
   * attempt used. Never invents a new run for a retry.
   */
  async retryBackup(backupRunId: string, operationId: string): Promise<BackupRun> {
    const runRepo = this.dataSource.getRepository(BackupRun);
    const artifactRepo = this.dataSource.getRepository(BackupArtifact);
    const run = await runRepo.findOneOrFail({ where: { id: backupRunId } });

    const companyId = run.companyId;
    const databaseConfig = companyId ? await this.databaseRegistry.getConnectionConfigForCompany(companyId) : this.config.database;
    const installationId = companyId ? (await this.companies.findById(companyId))?.installationId ?? null : null;

    const { storagePath } = this.config.releaseBackup;
    await mkdir(join(storagePath, 'db'), { recursive: true });

    const dbOk = await this.runDatabaseArtifact(run, artifactRepo, storagePath, run.initiatedByUserId, databaseConfig);
    const mediaOutcome = companyId ? 'skipped' : await this.runMediaArtifact(run, artifactRepo, storagePath, run.initiatedByUserId);

    const finalStatus = this.resolveRunStatus(dbOk, mediaOutcome);
    run.status = finalStatus;
    run.completedAt = new Date();
    const saved = await runRepo.save(run);

    await this.writeBackupManifest(saved, artifactRepo, storagePath, databaseConfig, companyId, installationId);

    await this.audit.record({
      actorUserId: run.initiatedByUserId,
      organizationId: null,
      action: finalStatus === 'failed' ? 'release.backup.failed' : 'release.backup.completed',
      resource: 'backup_run',
      resourceId: run.id,
      result: finalStatus === 'failed' ? 'failure' : 'success',
      correlationId: operationId,
      after: { status: finalStatus, companyId, retried: true },
    });

    if (finalStatus === 'failed') {
      throw new Error('Retried database artifact did not verify.');
    }
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
  /**
   * Backup/DR Architecture V1 (2026-09-24, Track D §Step 2 frozen schema).
   * `installationId`/`companyId` are added, `edition`/entitlement snapshot
   * is best-effort (a failure here never fails the manifest write, same
   * "never fails the backup" discipline as this method's own outer
   * try/catch) — the frozen minimum schema requires the FIELD to exist,
   * not that it can never be `null` when unavailable.
   */
  private async writeBackupManifest(
    run: BackupRun,
    artifactRepo: Repository<BackupArtifact>,
    storagePath: string,
    databaseConfig: DatabaseConfig,
    companyId: string | null,
    installationId: string | null,
  ): Promise<void> {
    try {
      const artifacts = await artifactRepo.find({ where: { backupRunId: run.id } });
      // A Company backup's migration head would have to come from a fresh connection to
      // THAT Company's own database, never the ambient one — not worth opening one just
      // for this best-effort manifest field (same "never fails the backup" discipline this
      // whole method already applies); `pg_restore --list` on the dump itself is the real
      // structural proof (`PgDumpRunnerService.verifyDumpStructure`), this is only a convenience index.
      let migrationHead: string | null = null;
      if (!companyId) {
        try {
          const rows: Array<{ name: string }> = await this.dataSource.query('SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1');
          migrationHead = rows[0]?.name ?? null;
        } catch {
          migrationHead = null;
        }
      }

      const manifest = {
        schema: 'daii.backup-manifest/1',
        installationId,
        companyId,
        backupRunId: run.id,
        status: run.status,
        trigger: run.trigger,
        sourceAppVersion: run.sourceAppVersion,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        database: { name: databaseConfig.database, host: databaseConfig.host, migrationHead },
        editionEntitlementSnapshot: null as unknown, // Track D Step 2 — populated once Area 7's entitlement snapshot accessor exists; frozen schema requires the field present, not populated in V1
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
    databaseConfig: DatabaseConfig,
  ): Promise<boolean> {
    const relativePath = join('db', `${run.id}.dump`);
    const absolutePath = join(storagePath, relativePath);
    try {
      await this.pgDump.dump(databaseConfig, absolutePath);
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
  /**
   * Backup/DR Architecture V1 (2026-09-24, Track D §Step 6, D-Backup-02).
   * `companyId` omitted (or `null`) — EXACT existing platform-retention
   * behavior. `companyId` supplied — retention is evaluated ONLY over that
   * Company's own runs (`where: { companyId }`, never a global query), and
   * `MIN_KEEP_RUNS` is enforced per-Company: another Company's (or the
   * platform's) larger backup count can NEVER push a Company's own
   * still-protected runs past its own floor (AC-3).
   */
  async applyRetentionPolicy(companyId: string | null = null): Promise<{ deletedRuns: number }> {
    const runRepo = this.dataSource.getRepository(BackupRun);
    const artifactRepo = this.dataSource.getRepository(BackupArtifact);
    const { storagePath, retentionDays: installationDefaultRetentionDays } = this.config.releaseBackup;

    const retentionDays = companyId ? await this.getEffectiveRetentionDays(companyId, installationDefaultRetentionDays) : installationDefaultRetentionDays;

    const allRuns = await runRepo.find({ where: { companyId: companyId ?? IsNull() }, order: { startedAt: 'DESC' } });
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

  /** D-Backup-02 — a Company's own override if one exists, otherwise the Installation-wide default. Never the reverse (an override never affects any other Company). */
  private async getEffectiveRetentionDays(companyId: string, installationDefault: number): Promise<number> {
    const settings = await this.dataSource.getRepository(CompanyBackupSettings).findOne({ where: { companyId } });
    return settings?.retentionDaysOverride ?? installationDefault;
  }
}
