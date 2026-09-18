/**
 * ERP Foundation P6 (T2, ADR-025 §4.1) — the boot-time snapshot of which
 * migration tags (`core` + entitled modules + closure) this installation's
 * schema was built with, resolved by the same dependency-free
 * `readEnabledModules()` the migration runner uses.
 *
 * A DI-injectable value so a consumer can assert "the modules I resolve at
 * request time (Entitlement Engine) match the modules whose tables actually
 * exist" — a mismatch means a half-applied deploy. Bound by
 * `EntitlementModule`; when unbound, consumers simply skip the check.
 */
export const ENABLED_MODULES = 'daii:enabled-modules';

export type EnabledModulesSnapshot = readonly string[];
