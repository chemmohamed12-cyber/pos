import { Injectable } from '@nestjs/common';

/**
 * Observability — Stage 2 build-order item 15.
 *
 * In-memory counters/timers — proportional to V1's single-instance
 * scale (same reasoning as xnexus-website's in-memory rate-limiter and
 * response-cache, both Class A per the extraction matrix). The contract
 * (increment/recordDuration) is what every domain codes against; the
 * storage backend upgrades to a real metrics system (e.g. Prometheus)
 * without callers changing, per ADR-016's L3-contract/L2-implementation
 * policy.
 */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, number[]>();

  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  recordDuration(name: string, milliseconds: number): void {
    const existing = this.durations.get(name) ?? [];
    existing.push(milliseconds);
    this.durations.set(name, existing);
  }

  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  getDurations(name: string): number[] {
    return this.durations.get(name) ?? [];
  }
}
