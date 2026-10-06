import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClosingSnapshotService } from './closing-snapshot.service';
import { CompanyConnectionManagerService } from '../../../foundation/database-registry/company-connection-manager.service';

/**
 * ADR-051 §12/§14 (Month-End Closing / Black Box, Phase 6). Same
 * `OnModuleInit` + `setInterval` + `OnModuleDestroy` shape as
 * `ApprovalExpiryScheduler`/`BackupSchedulerService` — the only scheduling
 * precedents in this codebase (`@nestjs/schedule` is NOT a dependency and
 * this does not add it). Inert under `NODE_ENV === 'test'` — the sweep is
 * exercised directly via `ClosingSnapshotService.retryPending()`/
 * `.detectOverdue()` in tests, never through a real timer.
 *
 * Fixed 5-minute cadence for V1 (no new Configuration Engine key) —
 * snapshot generation is expected to complete in well under a second
 * (proven live, Phase 5); a 5-minute sweep is purely a safety net for the
 * crash-mid-assembly case, not a normal-path dependency.
 *
 * Multi-Company Area 9 (2026-09-22) — `closing_snapshot_runs`/
 * `fiscal_periods`/`fiscal_years`/the 5 subledger contracts all live
 * inside EACH Company's own database (private-DB-per-Company
 * architecture), not one shared table. `runOnce` now sweeps every Company
 * whose database is `'ACTIVE'`, once each, via
 * `CompanyConnectionManagerService` — never the ambient connection for
 * this per-Company data. One Company's failure is logged and does not
 * stop the sweep for the rest. (`ClosingSnapshotSigningKeyService`
 * remains platform-wide by deliberate decision — not part of this fix.)
 */
@Injectable()
export class ClosingSnapshotRecoveryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClosingSnapshotRecoveryScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly snapshots: ClosingSnapshotService,
    private readonly connections: CompanyConnectionManagerService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => this.logger.error('Closing Snapshot recovery sweep failed', err instanceof Error ? err.stack : String(err)));
    }, 5 * 60 * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    const companyIds = await this.connections.listActiveCompanyIds();
    for (const companyId of companyIds) {
      try {
        const dataSource = await this.connections.getDataSource(companyId);
        await this.snapshots.retryPending(dataSource.manager);
        const overdue = await this.snapshots.detectOverdue(10, dataSource.manager);
        if (overdue.length > 0) {
          this.logger.warn(`Closing Snapshot recovery sweep — Company ${companyId}: ${overdue.length} run(s) still overdue after retry.`);
        }
      } catch (err) {
        this.logger.error(`Closing Snapshot recovery sweep failed for Company ${companyId}`, err instanceof Error ? err.stack : String(err));
      }
    }
  }
}
