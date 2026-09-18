import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { INVENTORY_RESERVATION_CONTRACT, InventoryReservationContract } from '../../../foundation/module-registry/contracts/inventory.contract';
import { SalesOrdersService } from './sales-orders.service';

const HOLD_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours — CTO directive §7's exact window
const POLL_INTERVAL_MS = 15 * 60 * 1000; // check every 15 minutes; expiry itself is measured from each reservation's own createdAt, not from poll timing

/**
 * Preliminary Hold Timeout (CTO directive §7) — a plain server-side
 * interval, not `@nestjs/schedule` (avoids adding a new dependency for
 * one job) and explicitly not a frontend timer, per the directive's own
 * instruction. `setInterval`, not `@Cron`: this only needs "roughly
 * every N minutes", not calendar-precise scheduling.
 */
@Injectable()
export class PreliminaryHoldExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PreliminaryHoldExpiryScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(INVENTORY_RESERVATION_CONTRACT) private readonly inventory: InventoryReservationContract,
    private readonly salesOrders: SalesOrdersService,
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
    const orderIds = await this.inventory.findExpiredPreliminaryHoldOrderIds(cutoff);
    for (const orderId of orderIds) {
      try {
        await this.salesOrders.expireHoldForOrder(orderId, null);
      } catch (err) {
        this.logger.error(`Failed to expire preliminary hold for order "${orderId}"`, err instanceof Error ? err.stack : String(err));
      }
    }
  }
}
