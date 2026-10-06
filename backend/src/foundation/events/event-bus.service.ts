import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { EventOutbox } from './event-outbox.entity';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';

/**
 * ADR-075 (D10) — the Company context a handler runs in. `manager === null`
 * means ambient/Platform processing (legacy behavior, unchanged); otherwise
 * `manager` is the Company's own database manager and EVERY read/write the
 * handler makes must go through it.
 */
export interface EventContext {
  manager: EntityManager | null;
  companyId: string | null;
}

export type EventHandler = (payload: Record<string, unknown>, ctx: EventContext) => Promise<void>;

/**
 * `'ambient'` (default, backward compatible): the handler uses its own
 * ambient `DataSource` and is therefore NEVER run against a Company outbox
 * (it would read/write the wrong database). `'company'`: the handler uses
 * `ctx.manager` and runs in both modes (`ctx.manager === null` ⇒ ambient).
 */
export type EventHandlerScope = 'ambient' | 'company';

interface Subscription {
  handler: EventHandler;
  scope: EventHandlerScope;
}

interface ClaimedRow {
  id: number;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
}

const MAX_ATTEMPTS = 5;
/** A Company-outbox row left `processing` longer than this (crashed dispatcher) becomes claimable again. */
const LEASE_MINUTES = 5;

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
 *
 * ADR-075 (D10, 2026-10-04) — Company context: a Company's outbox is
 * dispatched with that Company's manager, handlers receive `{manager,
 * companyId}`, and `'ambient'`-scope handlers are never run against a
 * Company outbox. Company dispatch claims rows with a short committed
 * lease (`FOR UPDATE SKIP LOCKED`), so the in-request flush and the
 * per-Company scheduler never process the same row twice — and no
 * connection is held across handler execution.
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);
  private readonly handlers = new Map<string, Subscription[]>();
  private readonly warnedAmbientOnly = new Set<string>();

  constructor(
    @InjectRepository(EventOutbox) private readonly outbox: Repository<EventOutbox>,
    @Optional() private readonly connections?: CompanyConnectionManagerService,
  ) {}

  subscribe(topic: string, handler: EventHandler, options?: { scope?: EventHandlerScope }): void {
    const existing = this.handlers.get(topic) ?? [];
    existing.push({ handler, scope: options?.scope ?? 'ambient' });
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
   * The in-request flush a service calls AFTER its own transaction has
   * committed. No manager ⇒ ambient dispatch (unchanged). A manager inside
   * an ACTIVE transaction ⇒ no-op (the caller owns the boundary and the
   * rows are not yet committed). Otherwise a Company root manager (e.g.
   * `req.companyContext.dataSource.manager`) ⇒ Company dispatch.
   */
  async dispatchAfterCommit(manager?: EntityManager, batchSize = 50): Promise<{ dispatched: number; failed: number }> {
    if (manager?.queryRunner?.isTransactionActive) return { dispatched: 0, failed: 0 };
    return this.dispatchPending(batchSize, manager);
  }

  /**
   * Dispatches pending events to subscribed handlers, in insertion order.
   * A failing handler does not block other events — it increments that
   * event's attempt count and leaves it pending for retry, up to
   * MAX_ATTEMPTS, after which it's marked failed (dead-letter-by-status,
   * not a separate DLQ table — proportional for V1 volume).
   *
   * No `manager` ⇒ the ambient outbox, every handler runs with
   * `ctx.manager === null` (unchanged legacy behavior). With a `manager`
   * (Multi-Company Area 9 / ADR-075) ⇒ that Company's outbox, `'company'`
   * handlers run with `ctx = {manager, companyId}`, `'ambient'` handlers
   * are never run.
   */
  async dispatchPending(batchSize = 50, manager?: EntityManager, companyId?: string | null): Promise<{ dispatched: number; failed: number }> {
    if (!manager) return this.dispatchAmbient(batchSize);

    const ctx: EventContext = {
      manager,
      companyId: companyId ?? this.connections?.companyIdOf(manager.connection) ?? null,
    };
    if (manager.queryRunner?.isTransactionActive) return this.dispatchInline(batchSize, manager, ctx);
    return this.dispatchClaimed(batchSize, manager, ctx);
  }

  /** Legacy path, byte-for-byte the pre-ADR-075 behavior (handlers just also receive a null ctx). */
  private async dispatchAmbient(batchSize: number): Promise<{ dispatched: number; failed: number }> {
    const ctx: EventContext = { manager: null, companyId: null };
    const pending = await this.outbox.find({ where: { status: 'pending' }, order: { id: 'ASC' }, take: batchSize });

    let dispatched = 0;
    let failed = 0;
    for (const row of pending) {
      const subs = this.handlers.get(row.topic) ?? [];
      try {
        for (const sub of subs) {
          await sub.handler(row.payload, ctx);
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

  /**
   * Company dispatch given a manager that is INSIDE an active transaction
   * (an uncommon, explicit caller choice — the rows it reads are its own).
   * Same semantics as ambient dispatch, but on that manager's outbox and
   * with Company-scope filtering; no lease (the caller's transaction is the
   * isolation boundary).
   */
  private async dispatchInline(batchSize: number, manager: EntityManager, ctx: EventContext): Promise<{ dispatched: number; failed: number }> {
    const repo = manager.getRepository(EventOutbox);
    const pending = await repo.find({ where: { status: 'pending' }, order: { id: 'ASC' }, take: batchSize });

    let dispatched = 0;
    let failed = 0;
    for (const row of pending) {
      const outcome = await this.runRow(row.topic, row.payload, ctx);
      if (outcome === 'failed') {
        row.attempts += 1;
        if (row.attempts >= MAX_ATTEMPTS) {
          row.status = 'failed';
          this.logger.error(`Event ${row.id} (${row.topic}) exhausted retries and was marked failed.`);
        }
        failed++;
      } else {
        row.status = outcome;
        row.dispatchedAt = new Date();
        if (outcome === 'dispatched') dispatched++;
      }
      await repo.save(row);
    }
    return { dispatched, failed };
  }

  /** Company dispatch with a short committed lease — see class doc. */
  private async dispatchClaimed(batchSize: number, manager: EntityManager, ctx: EventContext): Promise<{ dispatched: number; failed: number }> {
    const claimed: ClaimedRow[] = await manager.query(
      `WITH claimed AS (
         UPDATE "event_outbox" SET "status" = 'processing', "dispatchedAt" = now()
         WHERE "id" IN (
           SELECT "id" FROM "event_outbox"
           WHERE "status" = 'pending' OR ("status" = 'processing' AND "dispatchedAt" < now() - ($2 || ' minutes')::interval)
           ORDER BY "id" ASC LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         RETURNING "id", "topic", "payload", "attempts"
       ) SELECT * FROM claimed`,
      [batchSize, String(LEASE_MINUTES)],
    );
    claimed.sort((a, b) => a.id - b.id);

    let dispatched = 0;
    let failed = 0;
    for (const row of claimed) {
      const outcome = await this.runRow(row.topic, row.payload, ctx);
      if (outcome === 'failed') {
        const exhausted = row.attempts + 1 >= MAX_ATTEMPTS;
        await manager.query(`UPDATE "event_outbox" SET "attempts" = "attempts" + 1, "status" = $2, "dispatchedAt" = NULL WHERE "id" = $1`, [
          row.id,
          exhausted ? 'failed' : 'pending',
        ]);
        if (exhausted) this.logger.error(`Event ${row.id} (${row.topic}) exhausted retries and was marked failed.`);
        failed++;
      } else {
        await manager.query(`UPDATE "event_outbox" SET "status" = $2, "dispatchedAt" = now() WHERE "id" = $1`, [row.id, outcome]);
        if (outcome === 'dispatched') dispatched++;
      }
    }
    return { dispatched, failed };
  }

  /**
   * Runs the Company-runnable handlers for one row. A topic that has
   * subscribers but none of Company scope is `'skipped'` — visible, never
   * retried forever, never confused with `'dispatched'` (ADR-075 §2.3).
   */
  private async runRow(topic: string, payload: Record<string, unknown>, ctx: EventContext): Promise<'dispatched' | 'skipped' | 'failed'> {
    const subs = this.handlers.get(topic) ?? [];
    const runnable = subs.filter((s) => s.scope === 'company');
    if (subs.length > 0 && runnable.length === 0) {
      if (!this.warnedAmbientOnly.has(topic)) {
        this.warnedAmbientOnly.add(topic);
        this.logger.warn(`Topic "${topic}" has only ambient-scope subscribers — its Company-outbox events are marked 'skipped' (ADR-075 §5).`);
      }
      return 'skipped';
    }
    try {
      for (const sub of runnable) {
        await sub.handler(payload, ctx);
      }
      return 'dispatched';
    } catch (err) {
      this.logger.warn(`Event handler for "${topic}" failed in Company ${ctx.companyId ?? '?'}: ${err instanceof Error ? err.message : String(err)}`);
      return 'failed';
    }
  }
}
