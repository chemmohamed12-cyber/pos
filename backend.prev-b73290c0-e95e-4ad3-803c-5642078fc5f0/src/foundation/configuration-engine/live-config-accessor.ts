import { ConfigurationEngineService } from './configuration-engine.service';

/**
 * Security Assurance Gate — AUDIT-SEC-26 fix (2026-09-08). `@nestjs/throttler`'s
 * `@Throttle({ default: { limit, ttl } })` decorator is evaluated once, at
 * module-load time, before Nest's DI container exists — a decorator argument
 * has no `this`, so it cannot inject `ConfigurationEngineService` the normal
 * way. The library's own `Resolvable<T> = T | ((context) => T | Promise<T>)`
 * type (`throttler-module-options.interface.ts`) exists specifically so a
 * limit CAN be computed per-request instead of fixed at decoration time — but
 * that resolver function still needs some way to reach the live, DI-managed
 * `ConfigurationEngineService` instance (the admin-editable, hot-reloading
 * one — NOT the boot-time-only `AppConfigService`).
 *
 * This is the standard, narrowly-scoped answer to that specific gap: a
 * single settable/gettable reference, registered once by
 * `ConfigurationEngineService.onModuleInit()` after its own cache is
 * populated, read by any `Resolvable<T>` function that needs a LIVE config
 * value outside the normal constructor-injection path. Deliberately not a
 * general-purpose service locator — it exposes exactly one thing
 * (`ConfigurationEngineService`), for exactly this one class of caller
 * (decorator-argument resolver functions), and is safe to read from at any
 * time: `getLiveConfigEngine()` returns `null` before bootstrap completes,
 * and every caller is required to handle that.
 */
let instance: ConfigurationEngineService | null = null;

export function registerLiveConfigEngine(service: ConfigurationEngineService): void {
  instance = service;
}

export function getLiveConfigEngine(): ConfigurationEngineService | null {
  return instance;
}

/** Test-only escape hatch — never called from application code. */
export function resetLiveConfigEngineForTests(): void {
  instance = null;
}
