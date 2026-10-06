import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { stat } from 'fs/promises';
import { join } from 'path';
import { RestoreOperation } from './restore-operation.entity';
import { BackupRun } from './backup-run.entity';
import { BackupArtifact } from './backup-artifact.entity';
import { computeFileChecksum } from './checksum';
import { PgDumpRunnerService } from './pg-dump-runner.service';
import { BackupManagerService } from './backup-manager.service';
import { AppConfigService, DatabaseConfig } from '../configuration/app-config.service';
import { AuditService } from '../audit/audit.service';
import { AuditRecord } from '../audit/audit-record.entity';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';

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
    private readonly databaseRegistry: DatabaseRegistryService,
  ) {}

  /**
   * Read-only. Confirms the chosen backup actually has a verified
   * database artifact, that the file still exists on disk, and that its
   * checksum still matches what was recorded — never trusts a backup is
   * still good just because it was verified once, potentially a long
   * time ago. Creates a `RestoreOperation` row either way (even a failed
   * preflight is recorded, so there's a full audit trail of every restore
   * ATTEMPT, not just successful ones).
   *
   * Backup/DR Architecture V1 (2026-09-24, Track D §9 — the mandatory
   * security requirement, enforced here as a hard rejection, not a
   * filter): `companyId` (null for a platform restore) MUST match the
   * chosen `backupRun`'s OWN `companyId` exactly. A backup taken for
   * Company A can never become the source for a Company B (or platform)
   * restore, and a platform backup can never restore into a Company's
   * database — checked BEFORE any file/checksum work, let alone the
   * database itself.
   */
  async preflight(backupRunId: string, requestedByUserId: string, companyId: string | null = null): Promise<RestoreOperation> {
    const runRepo = this.dataSource.getRepository(BackupRun);
    const artifactRepo = this.dataSource.getRepository(BackupArtifact);
    const restoreRepo = this.dataSource.getRepository(RestoreOperation);

    const backupRun = await runRepo.findOne({ where: { id: backupRunId } });
    if (!backupRun) throw new NotFoundException(`Backup run "${backupRunId}" not found.`);
    if (backupRun.companyId !== companyId) {
      throw new ForbiddenException(
        `Backup run "${backupRunId}" belongs to ${backupRun.companyId ? `Company ${backupRun.companyId}` : 'the platform'}, not ${companyId ? `Company ${companyId}` : 'the platform'} — a backup can only ever restore the same Company (or platform) it was taken from.`,
      );
    }

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
        companyId,
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
      after: { backupRunId, checks, companyId },
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
        after: { companyId: operation.companyId },
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
      after: { companyId: operation.companyId },
    });

    try {
      const companyId = operation.companyId;
      const databaseConfig: DatabaseConfig = companyId
        ? await this.databaseRegistry.getConnectionConfigForCompany(companyId)
        : this.config.database;

      // The safety backup is of THIS SAME Company (or the platform) — never
      // a different one. `operation.companyId` was fixed at preflight time
      // and already validated to match the chosen backup's own Company.
      const safetyBackup = await this.backupManager.createBackup('pre_restore_safety', confirmedByUserId, companyId);
      operation.safetyBackupRunId = safetyBackup.id;
      await restoreRepo.save(operation);

      const artifactRepo = this.dataSource.getRepository(BackupArtifact);
      const dbArtifact = await artifactRepo.findOneOrFail({ where: { backupRunId: operation.backupRunId, type: 'database' } });
      const absolutePath = join(this.config.releaseBackup.storagePath, dbArtifact.filePath);

      await this.pgDump.restore(databaseConfig, absolutePath);

      // Minimal post-restore verification (Phase B scope) — confirms the
      // restored database actually responds to a query at all. A deeper
      // schema-readiness check (matching verify-deploy.sh's canary-table
      // pattern) belongs to the Health Check Manager, a later phase. Must
      // query the database that was JUST restored — the ambient connection
      // for a Company restore, never the platform's.
      if (companyId) {
        // `entities: [AuditRecord]` — needed for `verifyCompanyChain()`'s `.getRepository()` call
        // below (Area 14, 2026-09-25); this DataSource is otherwise only ever used for raw `.query()`.
        const verifyDataSource = new DataSource({ type: 'postgres', ...databaseConfig, synchronize: false, logging: false, entities: [AuditRecord] });
        await verifyDataSource.initialize();
        try {
          await verifyDataSource.query('SELECT 1');

          // Area 14 (2026-09-25, CTO Implementation Gate §7) — only verify
          // the Company's own audit chain if this restore's backup actually
          // carried one; a pre-Area-14 backup (zero rows) restores exactly
          // as it always has, never rejected for a chain that was never
          // there to begin with.
          const [{ count }] = await verifyDataSource.query('SELECT count(*)::text AS count FROM "audit_records"');
          if (Number(count) > 0) {
            const chain = await this.audit.verifyCompanyChain(verifyDataSource.manager);
            if (!chain.valid) {
              throw new Error(`Restored Company audit chain is broken at seq ${chain.brokenAtSeq} — restore rejected.`);
            }
          }
        } finally {
          if (verifyDataSource.isInitialized) await verifyDataSource.destroy();
        }
      } else {
        await this.dataSource.query('SELECT 1');
      }

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
        after: { backupRunId: operation.backupRunId, safetyBackupRunId: operation.safetyBackupRunId, companyId },
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
        after: { error: message, safetyBackupRunId: operation.safetyBackupRunId, companyId: operation.companyId },
      });
      throw err;
    }

    return operation;
  }
}
