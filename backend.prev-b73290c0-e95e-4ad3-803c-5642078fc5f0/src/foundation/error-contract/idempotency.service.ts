import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { IdempotencyRecord } from './idempotency-record.entity';

/**
 * Idempotency — Stage 2 build-order item 14.
 * Daii/architecture/DAII_FOUNDATION_CROSSCUTTING_SPEC.md §5,
 * DAII_API_ARCHITECTURE.md §6.
 *
 * Explicit, opt-in wrapper a controller/service calls around a
 * mutating operation — not a transparent global interceptor. Kept this
 * way deliberately (CTO Execution Policy §3: no unnecessary abstraction)
 * so the idempotency behavior is visible at the call site rather than
 * hidden in interceptor-ordering magic, consistent with how
 * RolesGuard/PermissionGuard are applied explicitly per route rather
 * than silently everywhere.
 *
 * This is the API-layer backstop for the client-side duplicate-submission
 * guard (DAII_SECURITY_ARCHITECTURE.md §4) — belt-and-suspenders, since
 * the client-side guard alone was exactly what failed in xnexus-website's
 * one documented incident (Daii/_source-audits/xnexus-website/).
 */
@Injectable()
export class IdempotencyService {
  constructor(
    @InjectRepository(IdempotencyRecord) private readonly records: Repository<IdempotencyRecord>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Runs `operation` at most once per (scope, key). A missing key means
   * idempotency is not requested for this call — runs unconditionally.
   * A replayed key returns the original cached result without
   * re-executing `operation`.
   *
   * Kept for any non-transactional caller (unchanged from its original
   * shape). For a mutating financial/inventory operation, prefer
   * `withIdempotencyInTransaction` below — Gap Resolution Package 3
   * (2026-09-14) found this method's dedup record is written only AFTER
   * `operation()` resolves, so a crash partway through `operation()`
   * leaves no record at all, and a retry with the same key re-runs
   * `operation()` from scratch instead of recovering — for `recordPayment`
   * specifically, that meant a second, independent Treasury cash-in leg
   * per retry (rows 33/34).
   */
  async withIdempotency<T>(scope: string, key: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (!key) return operation();

    const existing = await this.records.findOne({ where: { scope, key } });
    if (existing) {
      return existing.responseBody as T;
    }

    const result = await operation();

    try {
      await this.records.save(this.records.create({ scope, key, statusCode: 200, responseBody: result as unknown }));
    } catch {
      // Unique-constraint race: another concurrent request with the same
      // key won the insert first. Return ITS cached result, not ours —
      // this is what makes the guarantee "exactly one winner" under
      // concurrency, not just "usually one winner."
      const winner = await this.records.findOne({ where: { scope, key } });
      if (winner) return winner.responseBody as T;
      throw new Error(`Idempotency race for scope="${scope}" key="${key}" but no winning record found.`);
    }

    return result;
  }

  /**
   * Gap Resolution Package 3 (2026-09-14, Blueprint Amendment 6/Idempotency
   * redesign) — the transaction-aware variant. Opens exactly ONE
   * `dataSource.transaction()`; `fn` receives that transaction's own
   * `EntityManager` and must thread it through every write it makes (per
   * the Mandatory Implementation Invariant — `fn` must not open an
   * independent transaction of its own). A `pg_advisory_xact_lock` keyed
   * on `(scope, key)` — the same primitive already proven in the
   * Warehouse Issue Approval/Posting fix, keyed differently — serializes
   * two genuinely concurrent calls with the SAME key, so the dedup check
   * below is a fresh, lock-protected read, not a stale one. The dedup
   * record and `fn`'s own writes commit or roll back together: a crash
   * partway through `fn` leaves neither, so a retry with the same key
   * starts clean instead of re-running on top of a half-applied prior
   * attempt.
   */
  async withIdempotencyInTransaction<T>(scope: string, key: string | undefined, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      if (!key) return fn(manager);

      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`idempotency:${scope}:${key}`]);
      const records = manager.getRepository(IdempotencyRecord);
      const existing = await records.findOne({ where: { scope, key } });
      if (existing) return existing.responseBody as T;

      const result = await fn(manager);
      await records.save(records.create({ scope, key, statusCode: 200, responseBody: result as unknown }));
      return result;
    });
  }
}
