import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { INVENTORY_RESERVATION_CONTRACT, InventoryReservationContract } from '../../../foundation/module-registry/contracts/inventory.contract';
import { SalesOrdersService } from './sales-orders.service';
import { CompanyConnectionManagerService } from '../../../foundation/database-registry/company-connection-manager.service';
import { DataSource } from 'typeorm';
import { runOperationalAdmitted } from '../../../foundation/company/company-lifecycle-admission';

const HOLD_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours — CTO directive §7's exact window
const POLL_INTERVAL_MS = 15 * 60 * 1000; // check every 15 minutes; expiry itself is measured from each reservation's own createdAt, not from poll timing

/**
 * Preliminary Hold Timeout (CTO directive §7) — a plain server-side
 * interval, not `@nestjs/schedule` (avoids adding a new dependency for
 * one job) and explicitly not a frontend timer, per the directive's own
 * instruction. `setInterval`, not `@Cron`: this only needs "roughly
 * every N minutes", not calendar-precise scheduling.
 *
 * Multi-Company Area 9 (2026-09-22) — `stock_reservations`/`sales_orders`
 * live inside EACH Company's own database (private-DB-per-Company
 * architecture), not one shared table. `runOnce` now sweeps every Company
 * whose database is `'ACTIVE'`, once each, via
 * `CompanyConnectionManagerService` — never the ambient connection for
 * this per-Company data. One Company's failure is logged and does not
 * stop the sweep for the rest.
 */
@Injectable()
export class PreliminaryHoldExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PreliminaryHoldExpiryScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(INVENTORY_RESERVATION_CONTRACT) private readonly inventory: InventoryReservationContract,
    private readonly salesOrders: SalesOrdersService,
    private readonly connections: CompanyConnectionManagerService,
    private readonly platform: DataSource,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => this.logger.error('Preliminary hold expiry sweep failed', err instanceof Error ? err.stack : String(err)));
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    const cutoff = new Date(Date.now() - HOLD_DURATION_MS);
    const companyIds = await this.connections.listActiveCompanyIds();
    for (const companyId of companyIds) {
      try {
        // LA-1 Layer 2 (DP-9 O-1): expiring a hold modifies Company data, so it is OPERATIONAL work —
        // admitted only while the Company is READY, re-checked here at execution time (a Company
        // suspended after this sweep's list was built is skipped, the rest of the sweep continues).
        const admission = await runOperationalAdmitted(this.platform, this.connections, companyId, async (dataSource) => {
          const orderIds = await this.inventory.findExpiredPreliminaryHoldOrderIds(cutoff, dataSource.manager);
          for (const orderId of orderIds) {
            try {
              await this.salesOrders.expireHoldForOrder(orderId, null, dataSource.manager);
            } catch (err) {
              this.logger.error(
                `Failed to expire preliminary hold for order "${orderId}" (Company ${companyId})`,
                err instanceof Error ? err.stack : String(err),
              );
            }
          }
        });
        if (!admission.admitted) this.logger.log(`Preliminary hold expiry skipped for Company ${companyId}: not READY.`);
      } catch (err) {
        this.logger.error(`Preliminary hold expiry sweep failed for Company ${companyId}`, err instanceof Error ? err.stack : String(err));
      }
    }
  }
}
