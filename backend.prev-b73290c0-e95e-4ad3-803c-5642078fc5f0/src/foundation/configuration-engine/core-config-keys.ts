import { ConfigKeySource } from './config-key-source.type';

/**
 * `core`-owned config keys. `core` has no module manifest (ADR-024 §3.2),
 * so its keys are declared here. The security classification (platform_locked
 * / security_sensitive) is DERIVED by Team A — planning/erp-foundation/
 * P2_BLUEPRINT.md §7 — from SECURE_CODING_STANDARD.md §12–§14,
 * DAII_SECURITY_ARCHITECTURE.md §3, CUSTOMER_CONFIGURATION_ARCHITECTURE.md §2,
 * ADR-020 §4, and a scan of the current code for anything a value could
 * weaken.
 *
 * Adding / removing a key here is a one-line reviewed change. Any NEW key
 * that gates, weakens, or exposes a security control MUST be
 * securitySensitive:true and (barring justifiedUnlocked) platformLocked:true
 * — CI check CFG-5 enforces this.
 */
export const CORE_CONFIG_KEYS: readonly ConfigKeySource[] = [
  // --- security invariants — present only so an attempt to weaken them is a visible, rejected event ---
  {
    key: 'core.audit.enabled',
    ownerModule: 'core',
    valueType: 'bool',
    default: true,
    scopeLevels: ['platform'],
    platformLocked: true,
    securitySensitive: true,
    titleCode: 'config.core.audit.enabled',
    // Security Assurance Gate — AUDIT-SEC-26 (2026-09-08): this description
    // previously claimed an active write-time rejection mechanism that does
    // not exist anywhere in the codebase (`grep`-confirmed: this key is
    // never read, and no config-write path special-cases it). The
    // underlying safety property IS still true today — `AuditService.record()`
    // is unconditional and never reads this flag either, so the audit trail
    // genuinely cannot be disabled via this control right now — but not
    // because of anything THIS declaration enforces. Reclassified to state
    // that plainly rather than imply an active guard that isn't there.
    description:
      'Declared, but not currently wired to any enforcement point (neither a read gate on AuditService.record() nor a write-time rejection). The audit trail is unconditionally always-on in the current implementation regardless of this value — a real property, just not one this control actively enforces. See AUDIT-SEC-26.',
  },
  {
    key: 'core.release.pre_deploy_backup_required',
    ownerModule: 'core',
    valueType: 'bool',
    default: true,
    scopeLevels: ['platform'],
    platformLocked: true,
    securitySensitive: true,
    titleCode: 'config.core.release.pre_deploy_backup_required',
    // AUDIT-SEC-26: never read by ReleaseExecutionService — the "not
    // weakenable" property is real, but because deploy() unconditionally
    // requires `release.status === 'backup_verified'` in code, not because
    // this flag is checked. Reclassified for the same reason as
    // core.audit.enabled above.
    description:
      'Declared, but not currently read by ReleaseExecutionService.deploy() — the pre-deploy-backup requirement is unconditionally hardcoded in the release pipeline instead, so this flag has no live effect either way. See AUDIT-SEC-26.',
  },

  // --- security controls — Daii-only, bounded range (A-P2-1 CORRECTED 2026-09-06, Team B governance review) ---
  {
    key: 'core.security.rate_limit.auth_per_minute',
    ownerModule: 'core',
    valueType: 'int',
    allowed: { min: 3, max: 60 },
    default: 10,
    scopeLevels: ['platform', 'edition'],
    platformLocked: true,
    securitySensitive: true,
    titleCode: 'config.core.security.rate_limit.auth_per_minute',
    description:
      'Auth-route rate limit. Daii-managed only (platform/edition) — resolveConfig()\'s platform_locked short-circuit already skipped "installation" regardless of scopeLevels, so this key never actually accepted an installation-scope override; scopeLevels corrected to match. See A-P2-1 resolution.',
  },
  {
    key: 'core.security.session_idle_minutes',
    ownerModule: 'core',
    valueType: 'int',
    allowed: { min: 5, max: 1440 },
    default: 60,
    scopeLevels: ['platform', 'edition'],
    platformLocked: true,
    securitySensitive: true,
    titleCode: 'config.core.security.session_idle_minutes',
    description:
      'Idle timeout. Daii-managed only (platform/edition) — resolveConfig()\'s platform_locked short-circuit already skipped "installation" regardless of scopeLevels, so this key never actually accepted an installation-scope override; scopeLevels corrected to match. See A-P2-1 resolution.',
  },

  // --- security-adjacent — Daii-only ---
  {
    key: 'core.errors.verbosity',
    ownerModule: 'core',
    valueType: 'enum',
    allowed: ['minimal', 'standard'],
    default: 'standard',
    scopeLevels: ['platform', 'edition'],
    platformLocked: true,
    securitySensitive: true,
    titleCode: 'config.core.errors.verbosity',
    // AUDIT-SEC-26: AllExceptionsFilter never reads this key — every
    // response is already unconditionally sanitized to the safe generic
    // shape regardless of this value. "Never verbose to a client" is real,
    // enforced by the filter's own unconditional design, not by this
    // control choosing between 'minimal'/'standard' (neither of which was
    // ever "verbose" to begin with — ANY value here was always safe).
    description:
      'Declared, but not currently read by AllExceptionsFilter — client error responses are already unconditionally sanitized regardless of this value, so toggling between "minimal"/"standard" has no live effect today. See AUDIT-SEC-26.',
  },
  {
    key: 'core.cors.extra_allowed_origins',
    ownerModule: 'core',
    valueType: 'json',
    default: [],
    scopeLevels: ['platform', 'edition'],
    platformLocked: true,
    securitySensitive: true,
    titleCode: 'config.core.cors.extra_allowed_origins',
    // AUDIT-SEC-26: no CORS middleware exists anywhere in this app at all
    // (S12's own finding — same-origin SPA architecture, genuinely not
    // needed) — there is nothing for this value to add an origin TO. Real
    // wiring here means building actual CORS middleware from scratch, a
    // feature addition, not a cleanup fix — deliberately not rushed.
    description:
      'Declared, but no CORS middleware exists in this application to consume it — setting this has no live effect today (same-origin SPA architecture; see AUDIT-SEC-15/S12). Wiring this requires building real CORS support first. See AUDIT-SEC-26.',
  },
  {
    key: 'core.config.org_scope_enabled',
    ownerModule: 'core',
    valueType: 'bool',
    default: false,
    scopeLevels: ['platform'],
    platformLocked: true,
    isFeatureFlag: true,
    flagOwner: 'team-a-erp-foundation',
    flagRemoveBy: '2027-06-30',
    titleCode: 'config.core.config.org_scope_enabled',
    description: 'Gates the ORG/BRANCH precedence layer (deferred — P2_BLUEPRINT.md §0.2 / O-CC-2).',
  },
  {
    key: 'core.config.cache_reload_seconds',
    ownerModule: 'core',
    valueType: 'int',
    allowed: { min: 30, max: 3600 },
    default: 300,
    scopeLevels: ['platform'],
    platformLocked: true,
    titleCode: 'config.core.config.cache_reload_seconds',
    description: 'TTL backstop for the config cache against a missed configuration.changed event.',
  },

  // --- FA-01 Generic Approval / Maker-Checker Engine (APPROVAL_ENGINE_CONTRACT.md §7) ---
  // Operational only — none of these weakens the maker≠checker or minApprovers
  // invariants (those are engine-enforced, not config-driven). Disabling the
  // sweep only lets stale `pending` requests linger; it never auto-approves one.
  {
    key: 'core.approval.request_ttl_hours',
    ownerModule: 'core',
    valueType: 'int',
    allowed: { min: 1, max: 8760 },
    default: 168, // 7 days
    scopeLevels: ['platform', 'edition', 'installation'],
    titleCode: 'config.core.approval.request_ttl_hours',
    description: 'A `pending` ApprovalRequest older than this is transitioned to `expired` by the scheduled sweep.',
  },
  {
    key: 'core.approval.expire_sweep_enabled',
    ownerModule: 'core',
    valueType: 'bool',
    default: true,
    scopeLevels: ['platform', 'edition', 'installation'],
    titleCode: 'config.core.approval.expire_sweep_enabled',
    description: 'Master switch for the scheduled `expire` sweep. Off = stale pending requests are never auto-expired (they can still be withdrawn or decided).',
  },
  {
    key: 'core.approval.expire_sweep_interval_min',
    ownerModule: 'core',
    valueType: 'int',
    allowed: { min: 5, max: 1440 },
    default: 60,
    scopeLevels: ['platform', 'installation'],
    titleCode: 'config.core.approval.expire_sweep_interval_min',
    description: 'How often the `expire` sweep runs.',
  },

  // --- business / UX — customer choice ---
  {
    key: 'core.ui.default_language',
    ownerModule: 'core',
    valueType: 'enum',
    allowed: ['ar', 'en'],
    default: 'ar',
    scopeLevels: ['platform', 'edition', 'installation', 'user'],
    titleCode: 'config.core.ui.default_language',
  },
  {
    key: 'core.ui.density',
    ownerModule: 'core',
    valueType: 'enum',
    allowed: ['comfortable', 'compact'],
    default: 'comfortable',
    scopeLevels: ['platform', 'edition', 'installation', 'user'],
    titleCode: 'config.core.ui.density',
  },
  {
    key: 'core.ui.timezone',
    ownerModule: 'core',
    valueType: 'string',
    default: 'Africa/Cairo',
    scopeLevels: ['platform', 'edition', 'installation', 'user'],
    titleCode: 'config.core.ui.timezone',
  },
];
