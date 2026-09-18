import { Injectable, Logger } from '@nestjs/common';

/**
 * Observability — Stage 2 build-order item 15.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §19,
 * DAII_FOUNDATION_CROSSCUTTING_SPEC.md §3.
 *
 * One structured-logging convention every module uses, instead of each
 * domain inventing its own `console.log`/`Logger` shape. Thin by design —
 * wraps Nest's built-in Logger rather than replacing it with a new
 * logging framework (CTO Execution Policy §3: no unnecessary
 * abstraction). Upgrade path to a real log aggregator/APM is an
 * infrastructure choice, not a change to this contract.
 */
@Injectable()
export class DaiiLoggerService {
  private readonly logger = new Logger('Daii');

  logEvent(event: string, context: Record<string, unknown> = {}): void {
    this.logger.log(JSON.stringify({ event, ...context }));
  }

  logError(event: string, error: unknown, context: Record<string, unknown> = {}): void {
    const errorInfo = error instanceof Error ? { message: error.message, stack: error.stack } : { error };
    this.logger.error(JSON.stringify({ event, ...context, ...errorInfo }));
  }
}
