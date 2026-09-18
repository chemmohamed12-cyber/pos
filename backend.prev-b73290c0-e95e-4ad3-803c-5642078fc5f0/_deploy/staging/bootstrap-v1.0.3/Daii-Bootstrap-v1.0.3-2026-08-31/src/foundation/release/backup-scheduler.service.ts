import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BackupRun } from './backup-run.entity';
import { BackupManagerService } from './backup-manager.service';
import { AppConfigService } from '../configuration/app-config.service';

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

    this.logger.log('Starting scheduled backup.');
    await this.backupManager.createBackup('scheduled', null);
    await this.backupManager.applyRetentionPolicy();
  }

  private isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
}
