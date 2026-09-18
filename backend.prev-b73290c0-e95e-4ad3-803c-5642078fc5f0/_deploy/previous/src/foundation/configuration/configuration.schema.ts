import * as Joi from 'joi';

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
