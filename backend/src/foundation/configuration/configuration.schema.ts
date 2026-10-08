import * as Joi from 'joi';
import { basename, dirname, join } from 'path';

/**
 * Configuration Engine — Stage 2 build-order item 4.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §8.
 *
 * V1 scope only (per CTO Execution Directive Milestone 3 instruction):
 * environment config, validation, required/optional values, safe
 * defaults, secrets without dangerous defaults, typed access, clear
 * startup failure. NOT a full multi-tenant/DB-backed config platform —
 * that is future scope, not needed to reach the working business flow.
 *
 * Secret-default rule: DB_PASSWORD has a dev-only default so local
 * bootstrap works out of the box, but the default is refused outright
 * when NODE_ENV=production — mirrors DAII_SECURITY_ARCHITECTURE.md §5's
 * "fail closed, no default secret in production" rule.
 */
export const configurationValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().default(3000),

  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_USER: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  DB_PASSWORD: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(1).required().disallow('daii_dev_only').messages({
      'any.invalid': 'DB_PASSWORD must not be the dev-only default value when NODE_ENV=production.',
    }),
    otherwise: Joi.string().default('daii_dev_only'),
  }),

  // Authentication — build-order item 6. Same fail-closed-in-production
  // pattern as DB_PASSWORD (DAII_SECURITY_ARCHITECTURE.md §2/§5).
  JWT_ACCESS_SECRET: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required().disallow('daii_dev_jwt_access_secret_do_not_use_in_prod'),
    otherwise: Joi.string().default('daii_dev_jwt_access_secret_do_not_use_in_prod'),
  }),
  JWT_REFRESH_SECRET: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required().disallow('daii_dev_jwt_refresh_secret_do_not_use_in_prod'),
    otherwise: Joi.string().default('daii_dev_jwt_refresh_secret_do_not_use_in_prod'),
  }),
  JWT_ACCESS_TTL_SECONDS: Joi.number().default(900), // 15 minutes
  JWT_REFRESH_TTL_DAYS: Joi.number().default(30),

  // Media / Object Storage — build-order item 19. Local-filesystem
  // adapter path; the S3-compatible cloud adapter (not built in V1,
  // ADR-019) would add its own credential vars here when implemented.
  MEDIA_STORAGE_PATH: Joi.string().default('./storage/media'),

  // Release Center — Backup Foundation (Phase A). Same "defaults for
  // dev/local, overridable in production" discipline as MEDIA_STORAGE_PATH
  // above — none of these carry secrets, so no fail-closed-in-production
  // rule applies (unlike DB_PASSWORD/JWT_*/INTEGRATION_ENCRYPTION_KEY).
  RELEASE_BACKUP_STORAGE_PATH: Joi.string().default('./storage/backups'),
  RELEASE_BACKUP_RETENTION_DAYS: Joi.number().integer().min(1).default(30),
  RELEASE_BACKUP_SCHEDULE_HOUR: Joi.number().integer().min(0).max(23).default(2),
  // pg_dump / pg_restore. The bare command works in dev (on PATH); the
  // v1.0.3 deployment report (item 13/27) requires production to set the
  // ABSOLUTE CloudLinux path here — `verify-deploy.sh` / the deploy
  // preflight fail loudly if the configured value is not executable.
  PG_DUMP_BIN: Joi.string().default('pg_dump'),
  PG_RESTORE_BIN: Joi.string().default('pg_restore'),

  // Release Center — Execution Layer (Phase C) + v1.0.3 deployment
  // hardening. RELEASE_APP_ROOT defaults to the running process's own
  // working directory (matches main.ts's public/ resolution convention).
  // Production value (see PRODUCTION_DEPLOYMENT_GUIDE.md):
  //   /home/xnexdrgr/daii.xnexustech.com/release-new/backend
  RELEASE_APP_ROOT: Joi.string().default(process.cwd()),
  RELEASE_STAGING_PATH: Joi.string().default('./storage/release-staging'),
  // The path the frontend is ACTUALLY served from at runtime — the v1.0.3
  // report's item 5: the SPA is served from `backend/public`, NOT
  // `frontend/dist`. Defaults to `<RELEASE_APP_ROOT>/public`. The health
  // check reads `<this>/index.html` and asserts every referenced
  // `assets/*` bundle exists (frontend-bundle drift detection).
  FRONTEND_RUNTIME_PATH: Joi.string().default((parent) => join(parent.RELEASE_APP_ROOT ?? process.cwd(), 'public')),
  // Passenger reloads the app when this file's mtime changes (report item
  // 17). A successful deploy / rollback touches it. Defaults to
  // `<RELEASE_APP_ROOT>/tmp/restart.txt`.
  PASSENGER_RESTART_FILE: Joi.string().default((parent) => join(parent.RELEASE_APP_ROOT ?? process.cwd(), 'tmp', 'restart.txt')),
  // Absolute Node/npm binaries — the v1.0.3 build hit `/usr/bin/env: node:
  // Permission denied` because the correct Node was not on PATH (report
  // item 13). The build script (`tools/build/build-release.sh`) uses
  // these instead of a bare `node`/`npm`. Production value:
  //   /home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/{node,npm}
  NODE_BIN: Joi.string().default(process.execPath),
  NPM_BIN: Joi.string().default('npm'),
  // Caps Rolldown/Rayon worker threads during the frontend build — the
  // v1.0.3 build failed with `Rolldown panicked ... global thread pool ...
  // Resource temporarily unavailable` (EAGAIN) on a shared host (report
  // item 14). Exported as RAYON_NUM_THREADS by the build script.
  RELEASE_BUILD_MAX_THREADS: Joi.number().integer().min(1).default(2),

  // Release Center — Deploy/Rollback Engines (CTO-P3 + CTO-P1,
  // RELEASE_CONFIGURATION_SPEC.md §2.2). No secrets. Same discipline:
  // dev defaults present, production overrides the host paths, a wrong
  // value fails a loud preflight check — never a silent fallback.
  //
  // Parent dir where the sibling Release Slots (`<active>.prev-<id>`,
  // `<active>.failed-<id>`) and `_deploy/` live; the atomic swap renames
  // INSIDE this dir (same volume). Default = the parent of RELEASE_APP_ROOT.
  RELEASE_DEPLOY_ROOT: Joi.string().default((parent) => dirname(parent.RELEASE_APP_ROOT ?? process.cwd())),
  // The fixed PassengerAppRoot leaf, relative to RELEASE_DEPLOY_ROOT.
  // RELEASE_APP_ROOT must equal <RELEASE_DEPLOY_ROOT>/<RELEASE_ACTIVE_DIRNAME>
  // — the deploy preflight asserts this.
  RELEASE_ACTIVE_DIRNAME: Joi.string().default((parent) => basename(parent.RELEASE_APP_ROOT ?? process.cwd())),
  // Where LAST_KNOWN_GOOD.json + per-release deploy manifests are written.
  RELEASE_MANIFESTS_PATH: Joi.string().default('./storage/release-manifests'),
  // How many PREVIOUS and how many FAILED slots to keep; older pruned at COMMIT.
  RELEASE_SLOT_RETENTION: Joi.number().integer().min(1).default(1),
  // How many prior COMMITted releases LAST_KNOWN_GOOD.json keeps in history[]
  // (pop-on-rollback — RELEASE_ENGINES_SPEC.md Piece 3).
  RELEASE_LKG_HISTORY_DEPTH: Joi.number().integer().min(1).default(5),
  // Base URL + endpoints for the post-deploy HTTP health probes (each 2xx).
  RELEASE_HEALTH_BASE_URL: Joi.string().default((parent) => `http://localhost:${parent.PORT ?? 3000}`),
  RELEASE_HEALTH_ENDPOINTS: Joi.string().default('["/api/health","/api/health/deep","/api/health/db"]'),
  // Read-only post-deploy smoke: GET each, expect 2xx. The list that would
  // have caught the v1.0.3 404s — as config, not a .ts literal. Empty in dev.
  RELEASE_SMOKE_GET_ENDPOINTS: Joi.string().default('[]'),
  // Name of a pluggable mutating-smoke module (login→create→approve→cash-in),
  // registered by the app, not the engine. null → skip.
  RELEASE_SMOKE_SUITE: Joi.string().allow(null, '').default(null),
  // The COMPILED DataSource the deploy runs migrations against (no ts-node
  // in prod), relative to RELEASE_APP_ROOT.
  RELEASE_MIGRATION_DATASOURCE: Joi.string().default('dist/database/data-source.js'),
  // Reject a delta at assembly if any migration is not backward-compatible
  // with the outgoing release (Invariant I-8).
  RELEASE_EXPAND_CONTRACT_ENFORCE: Joi.boolean().default(true),
  // A delta touching package.json/package-lock.json: 'block' = refuse;
  // 'ack' = require an explicit operator ack + the nodevenv-install flow (I-9).
  RELEASE_DEPENDENCY_CHANGE_POLICY: Joi.string().valid('block', 'ack').default('ack'),
  // true  = the deploy uses the CANDIDATE-slot + atomic-rename-swap path
  //         (CTO-P3 / RELEASE_ENGINES_SPEC.md Piece 2).
  // false = the legacy in-place per-file copy + per-file snapshot rollback.
  // Additive: the engine rollout stays reversible (flip to false).
  RELEASE_STAGED_ACTIVATION: Joi.boolean().default(true),
  // Where a FAILED-SAFE alarm is POSTed (in addition to the audit row).
  // null → audit + log only.
  RELEASE_NOTIFY_WEBHOOK: Joi.string().uri().allow(null, '').default(null),

  // Company fan-out (CTO 2026-10-08). Whether a staged deploy also upgrades the EXISTING READY Company databases, not only the Platform database.
  //   off     = Platform only; no Company database is read or written (audited as such). The default — the capability is enabled deliberately.
  //   dry-run = plan only: discover READY Companies, derive each one's tags, report each one's pending migrations. Reads, never writes.
  //   on      = back up each affected Company, move it READY -> MIGRATING, migrate it, MIGRATING -> READY; stop at the first failure (pre-swap, ACTIVE untouched).
  // Requires RELEASE_STAGED_ACTIVATION=true (the legacy in-place path has no pre-swap point at which to run it).
  RELEASE_COMPANY_MIGRATIONS: Joi.string().valid('off', 'dry-run', 'on').default('off'),
  // How each affected Company gets its restore point before it is migrated.
  //   create         = the engine takes (and verifies) a `pre_update` backup of that Company's own database first.
  //   require-recent = a verified backup of that Company no older than RELEASE_COMPANY_BACKUP_MAX_AGE_HOURS must already exist.
  RELEASE_COMPANY_BACKUP_POLICY: Joi.string().valid('create', 'require-recent').default('create'),
  RELEASE_COMPANY_BACKUP_MAX_AGE_HOURS: Joi.number().integer().min(1).default(24),

  // Entitlement Engine (ERP Foundation P3) — DEPLOYMENT/verification config
  // (NOT business config; ADR-023 C5 keeps Edition/feature keys OUT of the
  // runtime Configuration Engine, but the manifest *verification* material
  // is a deployment concern and belongs here). P3_BLUEPRINT.md §8.
  //   unlicensed-full = a fresh install with no manifest runs the implicit
  //                     DAII_STANDARD edition (the current product, unchanged).
  //   enforced        = absent OR invalid manifest -> Core-only + alarm.
  ENTITLEMENT_MODE: Joi.string().valid('unlicensed-full', 'enforced').default('unlicensed-full'),
  // JSON array of { kid, spki_b64 } Ed25519 public verification keys. Offline
  // verification — never fetched at runtime. The private signing key is NEVER
  // in a customer installation.
  ENTITLEMENT_PUBLIC_KEYS: Joi.string().default('[]'),
  ENTITLEMENT_CLOCK_TOLERANCE_MINUTES: Joi.number().integer().min(1).default(10),

  // ADR-051 (Month-End Closing / Black Box). Both optional — unlike
  // JWT_ACCESS_SECRET, this capability has no default and no
  // production-required minimum yet (V1, dev/test scope). The app boots
  // fine with neither set; ClosingSnapshotSigningKeyService fails closed
  // only when a snapshot actually needs to be signed. PKCS8/DER, base64.
  CLOSING_SNAPSHOT_SIGNING_PRIVATE_KEY: Joi.string().optional(),
  CLOSING_SNAPSHOT_SIGNING_KID: Joi.string().optional(),

  // External Integrations (Control Center) — encrypts pairing
  // credentials (e.g. the QR Store connector's pairing token) at rest.
  // Same fail-closed-in-production pattern as the JWT secrets above —
  // directly acts on the lesson _source-audits/xnexus-website's own
  // capability audit §5 flags: that codebase's per-domain auth secrets
  // silently default to a well-known dev string in production. Must be
  // 32+ chars (AES-256-GCM key material, derived via scrypt below).
  INTEGRATION_ENCRYPTION_KEY: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required().disallow('daii_dev_integration_encryption_key_do_not_use_in_prod'),
    otherwise: Joi.string().default('daii_dev_integration_encryption_key_do_not_use_in_prod'),
  }),

  // Multi-Company Phase 3 V7, Area 3 (Database Registry). Same custody
  // model and fail-closed-in-production rule as INTEGRATION_ENCRYPTION_KEY
  // above — a deliberately SEPARATE key so a compromise of one secret
  // domain (integration pairing credentials) does not also expose the
  // other (per-Company database connection credentials).
  DATABASE_CREDENTIAL_ENCRYPTION_KEY: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required().disallow('daii_dev_database_credential_encryption_key_do_not_use_in_prod'),
    otherwise: Joi.string().default('daii_dev_database_credential_encryption_key_do_not_use_in_prod'),
  }),
});
