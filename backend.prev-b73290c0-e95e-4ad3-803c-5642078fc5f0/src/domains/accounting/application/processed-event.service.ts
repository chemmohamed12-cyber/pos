import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ProcessedEvent } from '../infrastructure/processed-event.entity';

/**
 * F01 — Financial Foundation (Blueprint §16/§17). Idempotency
 * infrastructure for the future Financial Event Engine (F03 onward) — no
 * caller in F01 itself. `checkAndMark` must be called INSIDE the same
 * transaction as the consumer's own business write: the unique
 * constraint on `(eventType, eventIdempotencyKey)` is the concurrency
 * control — a duplicate insert fails fast and is treated as "already
 * processed, skip," never surfaced as an error to the event publisher.
 */
@Injectable()
export class ProcessedEventService {
  /**
   * Returns `true` if this is the FIRST time this event has been seen
   * (the caller should proceed), `false` if it was already processed
   * (the caller should skip its business action but still succeed).
   */
  async checkAndMark(manager: EntityManager, eventType: string, eventIdempotencyKey: string, resultSummary: Record<string, unknown> | null = null): Promise<boolean> {
    const repo = manager.getRepository(ProcessedEvent);
    try {
      await repo.save(repo.create({ eventType, eventIdempotencyKey, resultSummary }));
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/duplicate key value violates unique constraint/i.test(message)) {
        return false;
      }
      throw err;
    }
  }
}
