import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ApprovalEngineService } from './approval-engine.service';
import { ConfigurationEngineService } from '../configuration-engine/configuration-engine.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { DataSource } from 'typeorm';
import { runOperationalAdmitted } from '../company/company-lifecycle-admission';

/**
 * FA-01 (contract §4). The scheduled `expire` sweep — same
 * `OnModuleInit` + `setInterval` + `OnModuleDestroy` shape as
 * `BackupSchedulerService` and `PreliminaryHoldExpiryScheduler` (the only
 * scheduling precedents in this codebase; `@nestjs/schedule` is NOT a
 * dependency and this does not add it).
 *
 * Reads `core.approval.expire_sweep_interval_min` for cadence and
 * `core.approval.expire_sweep_enabled` as the master switch, both live
 * from the Configuration Engine. Inert under test (`NODE_ENV === 'test'`)
 * — the sweep is exercised directly via `ApprovalEngineService.expire()`
 * in the specs, never through a real timer.
 *
 * Multi-Company Area 9 (2026-09-22) — `approval_requests` lives inside
 * EACH Company's own database (private-DB-per-Company architecture), not
 * one shared table. A single ambient-connection sweep therefore only ever
 * reached whichever one database the app's default `TypeOrmModule`
 * connection happened to point at. `runOnce` now sweeps every Company
 * whose database is `'ACTIVE'`, once each, via
 * `CompanyConnectionManagerService` — never the ambient connection for
 * this per-Company data. One Company's failure is logged and does not
 * stop the sweep for the rest.
 */
@Injectable()
export class ApprovalExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApprovalExpiryScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly engine: ApprovalEngineService,
    private readonly config: ConfigurationEngineService,
    private readonly connections: CompanyConnectionManagerService,
    private readonly platform: DataSource,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    let intervalMin = 60;
    try {
      intervalMin = this.config.get<number>('core.approval.expire_sweep_interval_min');
    } catch {
      // config not yet loaded at construction in some boot orders — fall back to the default cadence
    }
    this.timer = setInterval(() => {
      this.runOnce().catch((err) =>
        this.logger.error('Approval expiry sweep failed', err instanceof Error ? err.stack : String(err)),
      );
    }, Math.max(5, intervalMin) * 60 * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    let enabled = true;
    try {
      enabled = this.config.get<boolean>('core.approval.expire_sweep_enabled');
    } catch {
      /* default on */
    }
    if (!enabled) return;

    const companyIds = await this.connections.listActiveCompanyIds();
    for (const companyId of companyIds) {
      try {
        // LA-1 Layer 2 (DP-9 O-1): expiring approvals modifies Company data → OPERATIONAL, READY-only,
        // re-checked at execution time per Company.
        const admission = await runOperationalAdmitted(this.platform, this.connections, companyId, (dataSource) => this.engine.expire(dataSource));
        if (!admission.admitted) {
          this.logger.log(`Approval expiry sweep skipped for Company ${companyId}: not READY.`);
          continue;
        }
        const { expired } = admission.value;
        if (expired > 0) this.logger.log(`Approval expiry sweep — Company ${companyId}: ${expired} stale request(s) expired.`);
      } catch (err) {
        this.logger.error(`Approval expiry sweep failed for Company ${companyId}`, err instanceof Error ? err.stack : String(err));
      }
    }
  }
}
