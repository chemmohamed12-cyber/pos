import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BackupOperationService } from './backup-operation.service';
import { BackupManagerService, BACKUP_MAX_ATTEMPTS } from './backup-manager.service';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // same cadence as the other reconciliation/recovery schedulers in this codebase

/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 4/10, D-Backup-03).
 * Same `OnModuleInit` + `setInterval` + `OnModuleDestroy` shape as
 * `MembershipReconciliationScheduler`/`ClosingSnapshotRecoveryScheduler` —
 * the established scheduling precedent — but a DELIBERATELY SEPARATE
 * mechanism (own entity, own service, own scheduler): this models
 * external-process/job reliability (a `pg_dump`/`pg_restore` subprocess or
 * filesystem write failing), not cross-database consistency, per the
 * explicit CTO ruling not to reuse `MembershipOperation`'s ledger for a
 * different domain problem.
 *
 * Sweeps every `BackupOperation` left `FAILED` whose `nextRetryAt` has
 * arrived, and under `BACKUP_MAX_ATTEMPTS` (rows past the cap have
 * `nextRetryAt = null` and are therefore never selected — terminal by
 * construction, not a separate flag). Retries the SAME `BackupRun`
 * (`BackupManagerService.retryBackup`), never inventing a new one. One
 * operation's failure does not stop the sweep for the rest.
 */
@Injectable()
export class BackupReconciliationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupReconciliationScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly operations: BackupOperationService,
    private readonly backupManager: BackupManagerService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => this.logger.error('Backup reconciliation sweep failed', err instanceof Error ? err.stack : String(err)));
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    const retryable = await this.operations.findRetryable();
    for (const op of retryable) {
      try {
        await this.operations.markRetrying(op.id);
        await this.backupManager.retryBackup(op.backupRunId, op.correlationId);
        await this.operations.markCompleted(op.id);
        this.logger.log(`Backup reconciliation: operation ${op.id} (run ${op.backupRunId}) completed${op.companyId ? ` for Company ${op.companyId}` : ' (platform)'}.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.operations.markFailed(op.id, message, BACKUP_MAX_ATTEMPTS);
        this.logger.error(`Backup reconciliation failed for operation ${op.id} (run ${op.backupRunId})`, message);
      }
    }
  }
}
