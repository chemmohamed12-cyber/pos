import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClosingSnapshotService } from './closing-snapshot.service';

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
 */
@Injectable()
export class ClosingSnapshotRecoveryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClosingSnapshotRecoveryScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly snapshots: ClosingSnapshotService) {}

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
    await this.snapshots.retryPending();
    const overdue = await this.snapshots.detectOverdue();
    if (overdue.length > 0) this.logger.warn(`Closing Snapshot recovery sweep: ${overdue.length} run(s) still overdue after retry.`);
  }
}
