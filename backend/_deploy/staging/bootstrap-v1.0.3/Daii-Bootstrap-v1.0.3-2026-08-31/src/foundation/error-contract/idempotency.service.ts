import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  constructor(@InjectRepository(IdempotencyRecord) private readonly records: Repository<IdempotencyRecord>) {}

  /**
   * Runs `operation` at most once per (scope, key). A missing key means
   * idempotency is not requested for this call — runs unconditionally.
   * A replayed key returns the original cached result without
   * re-executing `operation`.
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
}
