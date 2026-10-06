import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BackupRun } from './backup-run.entity';
import { BackupManagerService } from './backup-manager.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';

const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 7, D-Backup-04).
 * Deliberately a DECOUPLED catch-up sweep, not an inline hook inside
 * `DatabaseProvisioningService.provision()` — this is the exact
 * architectural boundary the CTO ruling requires:
 *
 *   Provisioning → Health Check → READY → Baseline Backup (async)
 *
 * never
 *
 *   Provisioning → Baseline Backup → READY
 *
 * A decoupled sweep enforces this by construction: it has no access to,
 * and never touches, `CompanyStatus` in either direction — a failed
 * baseline backup can only ever leave a `BackupOperation` row `FAILED`/
 * `RETRYING` for `BackupReconciliationScheduler` to keep trying, never a
 * reason to revert or block a Company's own `READY` status. It also
 * naturally covers a Company that reaches `READY` via any path (including
 * a retried provisioning attempt), without needing a shared file edit
 * with whatever the Area 20 track's own `provision()` sequencing does.
 *
 * "Baseline" = the first backup ever taken for a Company — detected by
 * the simple absence of any `BackupRun` row for that `companyId`, not a
 * separate marker column.
 */
@Injectable()
export class CompanyBaselineBackupScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CompanyBaselineBackupScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly connections: CompanyConnectionManagerService,
    private readonly backupManager: BackupManagerService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => this.logger.error('Company baseline backup sweep failed', err instanceof Error ? err.stack : String(err)));
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    const companyIds = await this.connections.listActiveCompanyIds();
    const runRepo = this.dataSource.getRepository(BackupRun);
    for (const companyId of companyIds) {
      try {
        const existing = await runRepo.findOne({ where: { companyId } });
        if (existing) continue; // already has at least one backup — not this Company's first
        await this.backupManager.createBackup('baseline', null, companyId);
        this.logger.log(`Baseline backup created for Company ${companyId}.`);
      } catch (err) {
        // Never affects CompanyStatus — a failed baseline attempt is caught here, logged, and
        // left for BackupReconciliationScheduler (via the BackupOperation ledger already
        // recorded by createBackup itself) to retry. This Company's READY status is untouched.
        this.logger.error(`Baseline backup failed for Company ${companyId}`, err instanceof Error ? err.stack : String(err));
      }
    }
  }
}
