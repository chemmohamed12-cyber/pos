import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { stat } from 'fs/promises';
import { join } from 'path';
import { RestoreOperation } from './restore-operation.entity';
import { BackupRun } from './backup-run.entity';
import { BackupArtifact } from './backup-artifact.entity';
import { computeFileChecksum } from './checksum';
import { PgDumpRunnerService } from './pg-dump-runner.service';
import { BackupManagerService } from './backup-manager.service';
import { AppConfigService } from '../configuration/app-config.service';
import { AuditService } from '../audit/audit.service';

/** How long a preflighted restore stays confirmable before it must be re-preflighted — long enough for a human to read the preflight report and decide, short enough that a stale confirmation can't fire against a world that's since changed. */
const CONFIRMATION_WINDOW_MS = 15 * 60 * 1000;

/**
 * Release Center — Phase B (Restore). CTO directive's required flow:
 * Select Backup -> Preflight -> Validate -> Confirm -> Restore -> Verify
 * -> Audit. Split across two calls on purpose — `preflight()` NEVER
 * touches the database; `confirmAndRestore()` is the only method that
 * does, and only within the confirmation window, and only after taking
 * its own fresh safety backup of whatever is about to be overwritten.
 * "Restore must not be an operation that can be executed by accident with
 * one click" — this shape is why: two separate, deliberate API calls,
 * with a real decision point (and a real preflight report to read)
 * between them, not a single button.
 */
@Injectable()
export class RestoreManagerService {
  private readonly logger = new Logger(RestoreManagerService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
    private readonly pgDump: PgDumpRunnerService,
    private readonly backupManager: BackupManagerService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Read-only. Confirms the chosen backup actually has a verified
   * database artifact, that the file still exists on disk, and that its
   * checksum still matches what was recorded — never trusts a backup is
   * still good just because it was verified once, potentially a long
   * time ago. Creates a `RestoreOperation` row either way (even a failed
   * preflight is recorded, so there's a full audit trail of every restore
   * ATTEMPT, not just successful ones).
   */
  async preflight(backupRunId: string, requestedByUserId: string): Promise<RestoreOperation> {
    const runRepo = this.dataSource.getRepository(BackupRun);
    const artifactRepo = this.dataSource.getRepository(BackupArtifact);
    const restoreRepo = this.dataSource.getRepository(RestoreOperation);

    const backupRun = await runRepo.findOne({ where: { id: backupRunId } });
    if (!backupRun) throw new NotFoundException(`Backup run "${backupRunId}" not found.`);

    const artifacts = await artifactRepo.find({ where: { backupRunId } });
    const dbArtifact = artifacts.find((a) => a.type === 'database');

    const checks: Record<string, boolean> = {
      databaseArtifactExists: !!dbArtifact,
      databaseArtifactWasVerified: dbArtifact?.status === 'verified',
      fileStillExistsOnDisk: false,
      checksumStillMatches: false,
    };

    if (dbArtifact) {
      const absolutePath = join(this.config.releaseBackup.storagePath, dbArtifact.filePath);
      checks.fileStillExistsOnDisk = await stat(absolutePath)
        .then(() => true)
        .catch(() => false);
      if (checks.fileStillExistsOnDisk) {
        const currentChecksum = await computeFileChecksum(absolutePath);
        checks.checksumStillMatches = currentChecksum === dbArtifact.checksumSha256;
      }
    }

    const allPassed = Object.values(checks).every((v) => v === true);

    const operation = await restoreRepo.save(
      restoreRepo.create({
        backupRunId,
        status: allPassed ? 'pending_confirmation' : 'failed',
        requestedByUserId,
        expiresAt: new Date(Date.now() + CONFIRMATION_WINDOW_MS),
        preflightResult: {
          checks,
          backupSummary: { sourceAppVersion: backupRun.sourceAppVersion, startedAt: backupRun.startedAt, trigger: backupRun.trigger },
        },
        confirmedByUserId: null,
        confirmedAt: null,
        safetyBackupRunId: null,
        completedAt: allPassed ? null : new Date(),
        errorMessage: allPassed ? null : 'Preflight checks failed — see preflightResult.checks for which ones.',
      }),
    );

    await this.audit.record({
      actorUserId: requestedByUserId,
      organizationId: null,
      action: 'release.restore.preflight',
      resource: 'restore_operation',
      resourceId: operation.id,
      result: allPassed ? 'success' : 'denied',
      correlationId: null,
      after: { backupRunId, checks },
    });

    return operation;
  }

  /**
   * The only method in this codebase that actually overwrites live
   * database content via `pg_restore`. Re-validates the operation is
   * still `pending_confirmation` and still within its confirmation
   * window (never resumes a stale/expired confirmation), takes a fresh
   * safety backup of whatever is about to be overwritten BEFORE running
   * the restore (the recovery path if the restore itself goes wrong —
   * "do not leave the system in an unknown state" if it fails), then
   * restores, then a minimal post-restore verification (the database
   * responds at all), auditing every step distinctly.
   */
  async confirmAndRestore(restoreOperationId: string, confirmedByUserId: string): Promise<RestoreOperation> {
    const restoreRepo = this.dataSource.getRepository(RestoreOperation);
    const operation = await restoreRepo.findOne({ where: { id: restoreOperationId } });
    if (!operation) throw new NotFoundException(`Restore operation "${restoreOperationId}" not found.`);

    if (operation.status !== 'pending_confirmation') {
      throw new ConflictException(`Restore operation is "${operation.status}", not awaiting confirmation.`);
    }
    if (operation.expiresAt.getTime() < Date.now()) {
      operation.status = 'expired';
      await restoreRepo.save(operation);
      await this.audit.record({
        actorUserId: confirmedByUserId,
        organizationId: null,
        action: 'release.restore.expired',
        resource: 'restore_operation',
        resourceId: operation.id,
        result: 'denied',
        correlationId: null,
      });
      throw new ConflictException('This restore confirmation window has expired — run preflight again.');
    }

    operation.status = 'running';
    operation.confirmedByUserId = confirmedByUserId;
    operation.confirmedAt = new Date();
    await restoreRepo.save(operation);
    await this.audit.record({
      actorUserId: confirmedByUserId,
      organizationId: null,
      action: 'release.restore.confirmed',
      resource: 'restore_operation',
      resourceId: operation.id,
      result: 'success',
      correlationId: null,
    });

    try {
      const safetyBackup = await this.backupManager.createBackup('pre_restore_safety', confirmedByUserId);
      operation.safetyBackupRunId = safetyBackup.id;
      await restoreRepo.save(operation);

      const artifactRepo = this.dataSource.getRepository(BackupArtifact);
      const dbArtifact = await artifactRepo.findOneOrFail({ where: { backupRunId: operation.backupRunId, type: 'database' } });
      const absolutePath = join(this.config.releaseBackup.storagePath, dbArtifact.filePath);

      await this.pgDump.restore(this.config.database, absolutePath);

      // Minimal post-restore verification (Phase B scope) — confirms the
      // restored database actually responds to a query at all. A deeper
      // schema-readiness check (matching verify-deploy.sh's canary-table
      // pattern) belongs to the Health Check Manager, a later phase.
      await this.dataSource.query('SELECT 1');

      operation.status = 'completed';
      operation.completedAt = new Date();
      await restoreRepo.save(operation);
      await this.audit.record({
        actorUserId: confirmedByUserId,
        organizationId: null,
        action: 'release.restore.completed',
        resource: 'restore_operation',
        resourceId: operation.id,
        result: 'success',
        correlationId: null,
        after: { backupRunId: operation.backupRunId, safetyBackupRunId: operation.safetyBackupRunId },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Restore failed for operation "${operation.id}"`, err instanceof Error ? err.stack : message);
      operation.status = 'failed';
      operation.errorMessage = message;
      operation.completedAt = new Date();
      await restoreRepo.save(operation);
      await this.audit.record({
        actorUserId: confirmedByUserId,
        organizationId: null,
        action: 'release.restore.failed',
        resource: 'restore_operation',
        resourceId: operation.id,
        result: 'failure',
        correlationId: null,
        after: { error: message, safetyBackupRunId: operation.safetyBackupRunId },
      });
      throw err;
    }

    return operation;
  }
}
