import * as Joi from 'joi';
import { join } from 'path';

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
});
