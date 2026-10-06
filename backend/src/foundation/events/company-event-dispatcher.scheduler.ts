import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventBusService } from './event-bus.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';

const SWEEP_INTERVAL_MS = 30_000;
const BATCH_SIZE = 50;
/** Bound on consecutive full batches per Company per sweep, so one backlogged Company cannot starve the rest. */
const MAX_BATCHES_PER_COMPANY = 5;

/**
 * ADR-075 (D10) — the per-Company retry dispatcher. The in-request flush
 * (`EventBusService.dispatchAfterCommit`) is the normal path; this sweep is
 * the safety net for rows whose in-request dispatch failed, whose publisher
 * was not an HTTP request, or whose dispatcher crashed (leased rows are
 * re-claimable after the lease expires).
 *
 * Same `OnModuleInit` + `setInterval` + `OnModuleDestroy` shape as
 * `ApprovalExpiryScheduler` / `PreliminaryHoldExpiryScheduler`. Inert under
 * `NODE_ENV === 'test'` — exercised directly through `runOnce()`. Sweeps
 * every ACTIVE Company's OWN outbox with that Company's manager and
 * `companyId`; one Company's failure is logged and does not stop the rest.
 * The ambient/Platform outbox is not swept (nothing ever swept it).
 */
@Injectable()
export class CompanyEventDispatcherScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CompanyEventDispatcherScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly events: EventBusService,
    private readonly connections: CompanyConnectionManagerService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => this.logger.error('Company event dispatch sweep failed', err instanceof Error ? err.stack : String(err)));
    }, SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<{ companies: number; dispatched: number; failed: number }> {
    if (this.running) return { companies: 0, dispatched: 0, failed: 0 }; // a slow sweep never overlaps itself
    this.running = true;
    let companies = 0;
    let dispatched = 0;
    let failed = 0;
    try {
      const companyIds = await this.connections.listActiveCompanyIds();
      for (const companyId of companyIds) {
        try {
          const dataSource = await this.connections.getDataSource(companyId);
          for (let i = 0; i < MAX_BATCHES_PER_COMPANY; i++) {
            const result = await this.events.dispatchPending(BATCH_SIZE, dataSource.manager, companyId);
            dispatched += result.dispatched;
            failed += result.failed;
            if (result.dispatched + result.failed < BATCH_SIZE) break;
          }
          companies++;
        } catch (err) {
          this.logger.error(`Event dispatch sweep failed for Company ${companyId}`, err instanceof Error ? err.stack : String(err));
        }
      }
    } finally {
      this.running = false;
    }
    return { companies, dispatched, failed };
  }
}
