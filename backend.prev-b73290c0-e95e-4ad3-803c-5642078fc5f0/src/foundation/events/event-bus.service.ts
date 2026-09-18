import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { EventOutbox } from './event-outbox.entity';

export type EventHandler = (payload: Record<string, unknown>) => Promise<void>;

const MAX_ATTEMPTS = 5;

/**
 * Events (Event Engine) — Stage 2 build-order item 12.
 * Daii/architecture/DAII_EVENT_ARCHITECTURE.md, ADR-012, ADR-017.
 *
 * In-process pub/sub over the outbox table — deliberately NOT a message
 * broker (CTO Execution Policy §3: no unnecessary distributed systems
 * until real requirements justify one). Domain code never imports a
 * broker SDK; if Daii ever needs one, only this class's dispatch
 * mechanism changes, not any caller (ADR-012's contract-vs-implementation
 * separation, adapted from RMS's event-bus interface, Class C).
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);
  private readonly handlers = new Map<string, EventHandler[]>();

  constructor(@InjectRepository(EventOutbox) private readonly outbox: Repository<EventOutbox>) {}

  subscribe(topic: string, handler: EventHandler): void {
    const existing = this.handlers.get(topic) ?? [];
    existing.push(handler);
    this.handlers.set(topic, existing);
  }

  /**
   * Writes the outbox row using the CALLER's transaction manager — this
   * is the one thing that makes the outbox pattern correct. A caller
   * that publishes outside its own transaction has broken the guarantee;
   * there is no safe default manager to fall back to silently.
   */
  async publish(
    manager: EntityManager,
    topic: string,
    payload: Record<string, unknown>,
    schemaVersion = 1,
  ): Promise<void> {
    const repo = manager.getRepository(EventOutbox);
    await repo.save(repo.create({ topic, payload, schemaVersion, status: 'pending', attempts: 0 }));
  }

  /**
   * Dispatches pending events to subscribed handlers, in insertion order.
   * A failing handler does not block other events — it increments that
   * event's attempt count and leaves it pending for retry, up to
   * MAX_ATTEMPTS, after which it's marked failed (dead-letter-by-status,
   * not a separate DLQ table — proportional for V1 volume).
   */
  async dispatchPending(batchSize = 50): Promise<{ dispatched: number; failed: number }> {
    const pending = await this.outbox.find({
      where: { status: 'pending' },
      order: { id: 'ASC' },
      take: batchSize,
    });

    let dispatched = 0;
    let failed = 0;
    for (const row of pending) {
      const handlers = this.handlers.get(row.topic) ?? [];
      try {
        for (const handler of handlers) {
          await handler(row.payload);
        }
        row.status = 'dispatched';
        row.dispatchedAt = new Date();
        await this.outbox.save(row);
        dispatched++;
      } catch (err) {
        row.attempts += 1;
        if (row.attempts >= MAX_ATTEMPTS) {
          row.status = 'failed';
          this.logger.error(`Event ${row.id} (${row.topic}) exhausted retries and was marked failed.`, err as Error);
        }
        await this.outbox.save(row);
        failed++;
      }
    }
    return { dispatched, failed };
  }
}
