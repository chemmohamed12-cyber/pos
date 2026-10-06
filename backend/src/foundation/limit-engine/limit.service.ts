import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { LimitProfile } from './limit-profile.entity';
import { LimitUsageCounter } from './limit-usage-counter.entity';
import { LimitRegistrySeeder } from './limit-registry.seeder';
import { MODULE_REGISTRY } from '../module-registry/module-registry';
import { AuditService } from '../audit/audit.service';

export interface LimitKeyView {
  key: string;
  moduleCode: string;
  titleCode: string;
  unit: 'count' | 'per_month' | 'per_day' | 'bytes';
  usage: LimitCheckResult;
}

export interface LimitCheckResult {
  allowed: boolean;
  /** `null` when the key has no profile (unlimited) — never a number standing in for "no limit". */
  max: number | null;
  /** Current usage in the resolved period. `null` only alongside `max: null` (unlimited keys are not tracked — see class doc comment). */
  current: number | null;
  /** `null` when unlimited; otherwise `max - current`, floored at 0. */
  remaining: number | null;
}

/**
 * Limit Engine — ERP Foundation P5. `LIMIT_INTEGRATION_CONTRACT.md` §3/§4.
 *
 * `Entitlement ≠ Permission ≠ Limit ≠ Configuration` (explicit CTO
 * requirement, this task): this service answers ONE question only —
 * "how many of X may exist/happen, and how many already do" — a
 * quantitative, commercial-capacity question. It never asks "is this
 * Module/Feature turned on" (Entitlement — `@RequireModule`/
 * `@RequireFeature`, `entitlement/`), never "can this user do this"
 * (Permission — `@RequirePermission`, `permission/`), and never "what
 * value does this setting have" (Configuration — `ConfigurationEngineService`,
 * `configuration-engine/`). It reads and writes only its own two tables
 * (`limit_profiles`, `limit_usage_counters`) — no cross-engine table
 * access in either direction.
 *
 * Called from WITHIN a domain command (e.g. `CustomersService.createCustomer`
 * checking `sales.max_customers`), never from a controller or guard —
 * ADR-026's business-logic-owns-its-rules principle, and ADR-023 §3's own
 * enforcement-order table places Limit *after* Permission/Scope, closest
 * to the actual write, consistent with it being advisory (409) rather
 * than a route-level gate (404/403).
 *
 * Fail-open (ADR-023 §3, restated in the contract's own §4): a missing
 * `limit_profiles` row for a key means unlimited, not zero, not an
 * error. An unlimited key is deliberately NOT tracked in
 * `limit_usage_counters` at all (no profile => `check`/`consume` return
 * immediately, no counter row read or written) — accounting overhead for
 * a key nobody has ever chosen to cap is pure waste, and every manifest-
 * declared `limit_keys[].default` is `null` today (confirmed across all
 * 5 V1 manifests), so this is the path every existing call site takes
 * right now: zero behavior change from wiring this engine in.
 */
@Injectable()
export class LimitService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly seeder: LimitRegistrySeeder,
    private readonly audit: AuditService,
  ) {}

  /** Same boot-time seeding hook pattern as `ConfigurationEngineService` — seeds `limit_profiles` from every authored module's manifest defaults once per boot (additive-only, see `LimitRegistrySeeder`'s own doc comment). */
  async onModuleInit(): Promise<void> {
    await this.seeder.sync();
  }

  /**
   * Re-run the profile seeder — called by the Release Engine's "enable
   * Module M" deploy step (ERP Foundation P6) so a newly-entitled module's
   * manifest-declared limit profiles exist immediately. Idempotent
   * (additive-only, never clobbers an admin-adjusted row).
   */
  async resyncRegistry(): Promise<void> {
    await this.seeder.sync();
  }

  /**
   * Non-mutating preview — would `consume(limitKey, delta)` succeed right now.
   *
   * Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?`
   * added — `LimitProfile`/`LimitUsageCounter` are Company-owned entities
   * (`core-company-entities.ts`), so a caller checking a per-Company quota
   * (e.g. `CustomersService.createCustomer`'s `sales.max_customers`
   * pre-check) must resolve against that SAME Company's own counters, not
   * the ambient connection — same optional-external-manager shape already
   * established by `consume()`/`release()` below.
   */
  async check(limitKey: string, delta = 1, manager?: EntityManager): Promise<LimitCheckResult> {
    const run = (m: EntityManager) => this.resolve(m, limitKey, delta, false);
    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /**
   * Atomic check-and-increment, serialized per `limitKey` via a Postgres
   * advisory lock (same concurrency pattern as
   * `InventoryService.reserveStockInTransaction` — two concurrent
   * requests against the same near-full quota must not both succeed).
   * Only increments when `allowed` is true; a denied call leaves the
   * counter untouched.
   *
   * Accepts an optional external `manager` — same pattern as
   * `CustomerLedgerService.postEntry(input, manager?)` — so a caller that
   * already has its own open transaction (e.g. `CustomersService.
   * createCustomer`) can make the limit increment part of that SAME
   * atomic write: if the caller's transaction rolls back, the limit
   * increment rolls back with it, never leaving a "phantom" consumed
   * quota for a row that doesn't exist. Without a supplied `manager`,
   * opens its own transaction (used by direct/standalone callers, e.g.
   * the admin controller's read-back).
   */
  async consume(limitKey: string, delta = 1, manager?: EntityManager): Promise<LimitCheckResult> {
    const run = async (m: EntityManager) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`limit:${limitKey}`]);
      return this.resolve(m, limitKey, delta, true);
    };
    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /**
   * Releases previously-consumed usage (e.g. an order was cancelled,
   * give its quota back). No-ops silently for an unlimited key (nothing
   * was ever tracked to release) and never lets a counter go negative
   * (floored at 0 — a release can't be double-spent into credit). Same
   * optional external `manager` pattern as `consume()`.
   */
  async release(limitKey: string, delta = 1, manager?: EntityManager): Promise<void> {
    const run = async (m: EntityManager) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`limit:${limitKey}`]);
      const profile = await m.getRepository(LimitProfile).findOne({ where: { limitKey } });
      if (!profile) return;
      const periodStart = this.periodStart(profile.unit);
      const counterRepo = m.getRepository(LimitUsageCounter);
      const counter = await counterRepo.findOne({ where: { limitKey, periodStart: periodStart ?? IsNull() } });
      if (!counter) return;
      counter.currentValue = Math.max(0, counter.currentValue - delta);
      await counterRepo.save(counter);
    };
    if (manager) {
      await run(manager);
      return;
    }
    await this.dataSource.transaction(run);
  }

  /** Read-back (P5's own deliverable) — current usage without checking or mutating anything. */
  async getUsage(limitKey: string): Promise<LimitCheckResult> {
    return this.dataSource.transaction((manager) => this.resolve(manager, limitKey, 0, false));
  }

  /**
   * Admin API backing — every `limit_key` declared by any authored
   * module's manifest (in-memory `MODULE_REGISTRY`, same source
   * `LimitRegistrySeeder` reads), each with its live usage. Includes
   * keys with NO profile row (shown as unlimited) — the registry is the
   * declared surface; `limit_profiles` is only ever a subset of it.
   */
  async listKeys(): Promise<LimitKeyView[]> {
    const views: LimitKeyView[] = [];
    for (const code of MODULE_REGISTRY.authoredModuleCodes()) {
      const manifest = MODULE_REGISTRY.manifest(code);
      if (!manifest) continue;
      for (const lk of manifest.limit_keys) {
        views.push({
          key: lk.key,
          moduleCode: code,
          titleCode: lk.title_code,
          unit: lk.unit,
          usage: await this.getUsage(lk.key),
        });
      }
    }
    return views;
  }

  /** Admin sets/updates a key's cap. Must be a declared `limit_keys` entry — this is never a free-text key, same "no ad-hoc keys" discipline as `ConfigurationEngineService`. */
  async setProfile(limitKey: string, maxValue: number, actorUserId: string): Promise<void> {
    const meta = this.findKeyMeta(limitKey);
    const repo = this.dataSource.getRepository(LimitProfile);
    const existing = await repo.findOne({ where: { limitKey } });
    const before = existing?.maxValue ?? null;
    if (existing) {
      existing.maxValue = maxValue;
      await repo.save(existing);
    } else {
      await repo.save(repo.create({ limitKey, moduleCode: meta.moduleCode, unit: meta.unit, maxValue }));
    }
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'limit.profile.set',
      resource: 'limit_profiles',
      resourceId: limitKey,
      result: 'success',
      correlationId: null,
      before: { maxValue: before },
      after: { maxValue },
    });
  }

  /** Admin removes a key's cap — reverts it to fail-open unlimited (row absence), never a `maxValue: null` row. */
  async clearProfile(limitKey: string, actorUserId: string): Promise<void> {
    this.findKeyMeta(limitKey); // 404s for an undeclared key, same as setProfile
    const repo = this.dataSource.getRepository(LimitProfile);
    const existing = await repo.findOne({ where: { limitKey } });
    if (!existing) return; // already unlimited — clearing an absent profile is a no-op, not an error
    await repo.remove(existing);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'limit.profile.cleared',
      resource: 'limit_profiles',
      resourceId: limitKey,
      result: 'success',
      correlationId: null,
      before: { maxValue: existing.maxValue },
      after: { maxValue: null },
    });
  }

  private findKeyMeta(limitKey: string): { moduleCode: string; unit: LimitProfile['unit'] } {
    for (const code of MODULE_REGISTRY.authoredModuleCodes()) {
      const manifest = MODULE_REGISTRY.manifest(code);
      const lk = manifest?.limit_keys.find((k) => k.key === limitKey);
      if (lk) return { moduleCode: code, unit: lk.unit };
    }
    throw new NotFoundException(`"${limitKey}" is not a declared limit key.`);
  }

  private async resolve(manager: EntityManager, limitKey: string, delta: number, mutate: boolean): Promise<LimitCheckResult> {
    const profile = await manager.getRepository(LimitProfile).findOne({ where: { limitKey } });
    if (!profile) {
      // Fail-open: no profile => unlimited, untracked (see class doc comment).
      return { allowed: true, max: null, current: null, remaining: null };
    }

    const periodStart = this.periodStart(profile.unit);
    const counterRepo = manager.getRepository(LimitUsageCounter);
    let counter = await counterRepo.findOne({ where: { limitKey, periodStart: periodStart ?? IsNull() } });
    const currentValue = counter?.currentValue ?? 0;
    const projected = currentValue + delta;
    const allowed = projected <= profile.maxValue;

    if (mutate && allowed) {
      if (!counter) {
        counter = counterRepo.create({ limitKey, periodStart, currentValue: 0 });
      }
      counter.currentValue = projected;
      await counterRepo.save(counter);
    }

    const effectiveCurrent = mutate && allowed ? projected : currentValue;
    return {
      allowed,
      max: profile.maxValue,
      current: effectiveCurrent,
      remaining: Math.max(0, profile.maxValue - effectiveCurrent),
    };
  }

  /** `null` for a flat limit (one counter for its whole lifetime); the current UTC calendar-period start for a windowed one. Calendar-boundary interpretation is this engine's own reasonable default, not a separately CTO-approved decision — `LIMIT_INTEGRATION_CONTRACT.md` §6 explicitly leaves period semantics as "a placeholder, not a decision". */
  private periodStart(unit: LimitProfile['unit']): Date | null {
    const now = new Date();
    if (unit === 'per_day') {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    }
    if (unit === 'per_month') {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    }
    return null;
  }
}
