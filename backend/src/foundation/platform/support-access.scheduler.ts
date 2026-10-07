import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SupportAccessService } from './support-access.service';

const POLL_INTERVAL_MS = 60 * 1000;

/**
 * Closes expired support access (Company-side role removed, membership deleted, closing audit in both chains). The access guards already refuse an expired
 * membership on every request, so this timer is hygiene and audit, not the security boundary. Same `setInterval` shape as the other schedulers; disabled under test.
 */
@Injectable()
export class SupportAccessScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SupportAccessScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly support: SupportAccessService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.support.expireDue().catch((err) => this.logger.error('Support access sweep failed', err instanceof Error ? err.stack : String(err)));
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
