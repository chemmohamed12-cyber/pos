import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BackupRun } from './backup-run.entity';
import { BackupManagerService } from './backup-manager.service';
import { AppConfigService } from '../configuration/app-config.service';
import { AuditService } from '../audit/audit.service';

/** Check hourly whether today's scheduled backup is due — same "roughly every N minutes, not calendar-precise" discipline as `PreliminaryHoldExpiryScheduler`, the only scheduling precedent in this codebase (`@nestjs/schedule` is not a dependency and this doesn't add it). */
const POLL_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Release Center — Phase A (Backup Foundation). CTO directive's
 * "Automatic Scheduled Backup" requirement: Daily -> Create -> Verify ->
 * Store -> Retention. Verify/Store/Retention are already inside
 * `BackupManagerService.createBackup`/`applyRetentionPolicy`; this class
 * is only the "is it time yet" decision, same shape as
 * `PreliminaryHoldExpiryScheduler` (`src/domains/sales-orders/application/`).
 */
@Injectable()
export class BackupSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
    private readonly backupManager: BackupManagerService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => this.logger.error('Scheduled backup check failed', err instanceof Error ? err.stack : String(err)));
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    const now = new Date();
    if (now.getHours() < this.config.releaseBackup.scheduleHour) return;

    const runRepo = this.dataSource.getRepository(BackupRun);
    const lastScheduled = await runRepo.findOne({ where: { trigger: 'scheduled' }, order: { startedAt: 'DESC' } });
    if (lastScheduled && this.isSameDay(lastScheduled.startedAt, now)) return;

    // Commercial Release Gate finding SEC-09 (red-team RT09): the audit
    // hash-chain was written correctly and a correct `verifyChain()` existed,
    // but NOTHING ever called it — outside its own unit test, the chain was
    // never checked, so tampering with `audit_records` would have gone
    // undetected forever. `audit.service.spec.ts`'s own header already
    // described `verifyChain()` as "the code path Backup/Recovery integrity
    // verification [uses]" — it just was not wired. Verifying immediately
    // BEFORE each scheduled backup is the right seam: it means every stored
    // backup carries a recorded verdict about the integrity of the audit
    // trail it contains. A broken chain is logged loudly and recorded as a
    // security alarm, and deliberately does NOT abort the backup — a
    // tampered-with audit trail is exactly when you most want a backup taken.
    try {
      const integrity = await this.audit.verifyChain();
      if (!integrity.valid) {
        this.logger.error(`AUDIT CHAIN INTEGRITY FAILURE — chain broken at seq ${integrity.brokenAtSeq}. Backup proceeding; investigate immediately.`);
        await this.audit.record({
          actorUserId: null,
          organizationId: null,
          action: 'security.audit.chain_broken',
          resource: 'audit_records',
          resourceId: String(integrity.brokenAtSeq ?? ''),
          result: 'denied',
          correlationId: null,
          after: { brokenAtSeq: integrity.brokenAtSeq },
        });
      } else {
        this.logger.log('Audit chain integrity verified.');
      }
    } catch (err) {
      // Never let an integrity check failure stop the backup itself.
      this.logger.error('Audit chain verification errored', err instanceof Error ? err.stack : String(err));
    }

    this.logger.log('Starting scheduled backup.');
    await this.backupManager.createBackup('scheduled', null);
    await this.backupManager.applyRetentionPolicy();
  }

  private isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
}
