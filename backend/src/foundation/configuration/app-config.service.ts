import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface AuthConfig {
  accessSecret: string;
  refreshSecret: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
}

export interface ReleaseBackupConfig {
  storagePath: string;
  retentionDays: number;
  scheduleHour: number;
  pgDumpBin: string;
  pgRestoreBin: string;
}

export interface ReleaseExecutionConfig {
  appRoot: string;
  stagingPath: string;
  /** Where the SPA is actually served from at runtime — `backend/public`, not `frontend/dist` (v1.0.3 report item 5). */
  frontendRuntimePath: string;
  /** Touching this file makes Passenger reload the app (v1.0.3 report item 17). */
  passengerRestartFile: string;
}

export interface ReleaseBuildConfig {
  nodeBin: string;
  npmBin: string;
  maxThreads: number;
}

export interface EntitlementPublicKeyConfig {
  kid: string;
  spki_b64: string;
}

/**
 * ADR-051 §9 (Month-End Closing / Black Box). Both nullable — unlike
 * `AuthConfig`'s `!`-forced secrets, this capability is not on the
 * request-handling hot path at startup, so the app must still boot with
 * neither set; `ClosingSnapshotSigningKeyService` fails closed (a clear
 * error) only when a snapshot actually needs to be signed. Never stored in
 * the database — env-var only, same custody model as `JWT_ACCESS_SECRET`.
 */
export interface ClosingSnapshotSigningConfig {
  privateKeyB64: string | null;
  kid: string | null;
}

export interface EntitlementConfig {
  /** 'unlicensed-full' => a fresh install with no manifest runs the implicit DAII_STANDARD edition. */
  mode: 'unlicensed-full' | 'enforced';
  publicKeys: EntitlementPublicKeyConfig[];
  clockToleranceMinutes: number;
}

/**
 * CTO-P3 (Deploy / Preflight / Verify / Promote — Release Slots + Staged
 * Activation) + CTO-P1 (Backup / Recovery / Rollback / LKG / FAILED-SAFE).
 * Every path/URL/policy the Deploy & Rollback engines need — no literal
 * `release-new/backend`, no `.ts` endpoint list. See
 * `RELEASE_CONFIGURATION_SPEC.md` §2.2.
 */
export interface ReleaseDeployConfig {
  /** Parent dir where the sibling Release Slots + `_deploy/` live; the atomic swap renames inside this dir (same volume). */
  deployRoot: string;
  /** The fixed PassengerAppRoot leaf, relative to `deployRoot`. `appRoot` must equal `<deployRoot>/<activeDirname>`. */
  activeDirname: string;
  /** Where `LAST_KNOWN_GOOD.json` + per-release deploy manifests are written. */
  manifestsPath: string;
  /** How many PREVIOUS and how many FAILED slots to keep; older pruned at COMMIT. */
  slotRetention: number;
  /** How many prior COMMITted releases `LAST_KNOWN_GOOD.json` keeps in `history[]`. */
  lkgHistoryDepth: number;
  /** Base URL for the post-deploy HTTP health probes. */
  healthBaseUrl: string;
  /** Health probe paths, in order — each must return 2xx. */
  healthEndpoints: string[];
  /** Read-only post-deploy smoke: GET each, expect 2xx. The v1.0.3-404 guard list, as config. */
  smokeGetEndpoints: string[];
  /** Name of a pluggable mutating-smoke module; `null` → skip. */
  smokeSuite: string | null;
  /** The compiled DataSource the deploy runs migrations against, relative to `appRoot`. */
  migrationDatasource: string;
  /** Reject a delta at assembly if a migration is not backward-compatible with the outgoing release (I-8). */
  expandContractEnforce: boolean;
  /** A delta touching `package.json`/`package-lock.json`: `block` = refuse; `ack` = require operator ack + nodevenv-install flow (I-9). */
  dependencyChangePolicy: 'block' | 'ack';
  /** Where a FAILED-SAFE alarm is POSTed (besides the audit row); `null` → audit + log only. */
  notifyWebhook: string | null;
  /** `true` = CANDIDATE-slot + atomic-swap deploy path (CTO-P3); `false` = legacy in-place copy. */
  stagedActivation: boolean;
  /** Public base URL the restarted application answers on; `null` = readiness cannot be verified over HTTP (the deploy is then recorded DEPLOYED_UNVERIFIED). */
  readinessUrl: string | null;
  /** How long the engine waits for the restarted application to answer 2xx on every health endpoint before rolling back. */
  readinessTimeoutSeconds: number;
  /** Company fan-out: `off` = Platform database only; `dry-run` = plan/report only; `on` = also upgrade every applicable READY Company database (staged path only). */
  companyMigrations: 'off' | 'dry-run' | 'on';
  /** Restore-point policy for each Company about to be migrated: take a fresh verified backup, or require a recent verified one. */
  companyBackupPolicy: 'create' | 'require-recent';
  /** `require-recent` only: how old (hours) a verified Company backup may be. */
  companyBackupMaxAgeHours: number;
}

/**
 * Typed access facade over the validated environment (Foundation Contract
 * §8's "typed access" requirement). Every consumer gets typed getters
 * instead of scattering `configService.get('DB_HOST')` string-keyed calls
 * throughout the codebase. Values are guaranteed present because
 * ConfigurationModule's Joi schema already validated them at startup —
 * the non-null assertions below reflect that guarantee, not a hope.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  get nodeEnv(): 'development' | 'test' | 'production' {
    return this.configService.get<string>('NODE_ENV')! as 'development' | 'test' | 'production';
  }

  get appPort(): number {
    return this.configService.get<number>('PORT')!;
  }

  get database(): DatabaseConfig {
    return {
      host: this.configService.get<string>('DB_HOST')!,
      port: this.configService.get<number>('DB_PORT')!,
      username: this.configService.get<string>('DB_USER')!,
      password: this.configService.get<string>('DB_PASSWORD')!,
      database: this.configService.get<string>('DB_NAME')!,
    };
  }

  get auth(): AuthConfig {
    return {
      accessSecret: this.configService.get<string>('JWT_ACCESS_SECRET')!,
      refreshSecret: this.configService.get<string>('JWT_REFRESH_SECRET')!,
      accessTtlSeconds: this.configService.get<number>('JWT_ACCESS_TTL_SECONDS')!,
      refreshTtlDays: this.configService.get<number>('JWT_REFRESH_TTL_DAYS')!,
    };
  }

  get mediaStoragePath(): string {
    return this.configService.get<string>('MEDIA_STORAGE_PATH')!;
  }

  get integrationEncryptionKey(): string {
    return this.configService.get<string>('INTEGRATION_ENCRYPTION_KEY')!;
  }

  /** Multi-Company Phase 3 V7, Area 3 (Database Registry) — deliberately separate from `integrationEncryptionKey`. */
  get databaseCredentialEncryptionKey(): string {
    return this.configService.get<string>('DATABASE_CREDENTIAL_ENCRYPTION_KEY')!;
  }

  get entitlement(): EntitlementConfig {
    const rawKeys = this.configService.get<string>('ENTITLEMENT_PUBLIC_KEYS') ?? '[]';
    let publicKeys: EntitlementPublicKeyConfig[] = [];
    try {
      const parsed: unknown = JSON.parse(rawKeys);
      if (Array.isArray(parsed)) {
        publicKeys = parsed.filter(
          (k): k is EntitlementPublicKeyConfig =>
            !!k && typeof k === 'object' && typeof (k as Record<string, unknown>).kid === 'string' && typeof (k as Record<string, unknown>).spki_b64 === 'string',
        );
      }
    } catch (err) {
      throw new Error(`Config ENTITLEMENT_PUBLIC_KEYS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      mode: this.configService.get<'unlicensed-full' | 'enforced'>('ENTITLEMENT_MODE')!,
      publicKeys,
      clockToleranceMinutes: this.configService.get<number>('ENTITLEMENT_CLOCK_TOLERANCE_MINUTES')!,
    };
  }

  get closingSnapshotSigning(): ClosingSnapshotSigningConfig {
    return {
      privateKeyB64: this.configService.get<string>('CLOSING_SNAPSHOT_SIGNING_PRIVATE_KEY') ?? null,
      kid: this.configService.get<string>('CLOSING_SNAPSHOT_SIGNING_KID') ?? null,
    };
  }

  get releaseBackup(): ReleaseBackupConfig {
    return {
      storagePath: this.configService.get<string>('RELEASE_BACKUP_STORAGE_PATH')!,
      retentionDays: this.configService.get<number>('RELEASE_BACKUP_RETENTION_DAYS')!,
      scheduleHour: this.configService.get<number>('RELEASE_BACKUP_SCHEDULE_HOUR')!,
      pgDumpBin: this.configService.get<string>('PG_DUMP_BIN')!,
      pgRestoreBin: this.configService.get<string>('PG_RESTORE_BIN')!,
    };
  }

  get releaseExecution(): ReleaseExecutionConfig {
    return {
      appRoot: this.configService.get<string>('RELEASE_APP_ROOT')!,
      stagingPath: this.configService.get<string>('RELEASE_STAGING_PATH')!,
      frontendRuntimePath: this.configService.get<string>('FRONTEND_RUNTIME_PATH')!,
      passengerRestartFile: this.configService.get<string>('PASSENGER_RESTART_FILE')!,
    };
  }

  get releaseBuild(): ReleaseBuildConfig {
    return {
      nodeBin: this.configService.get<string>('NODE_BIN')!,
      npmBin: this.configService.get<string>('NPM_BIN')!,
      maxThreads: this.configService.get<number>('RELEASE_BUILD_MAX_THREADS')!,
    };
  }

  get releaseDeploy(): ReleaseDeployConfig {
    const nullable = (k: string): string | null => {
      const v = this.configService.get<string>(k);
      return v === undefined || v === null || v === '' ? null : v;
    };
    return {
      deployRoot: this.configService.get<string>('RELEASE_DEPLOY_ROOT')!,
      activeDirname: this.configService.get<string>('RELEASE_ACTIVE_DIRNAME')!,
      manifestsPath: this.configService.get<string>('RELEASE_MANIFESTS_PATH')!,
      slotRetention: this.configService.get<number>('RELEASE_SLOT_RETENTION')!,
      lkgHistoryDepth: this.configService.get<number>('RELEASE_LKG_HISTORY_DEPTH')!,
      healthBaseUrl: this.configService.get<string>('RELEASE_HEALTH_BASE_URL')!,
      healthEndpoints: parseJsonStringArray(this.configService.get<string>('RELEASE_HEALTH_ENDPOINTS'), 'RELEASE_HEALTH_ENDPOINTS'),
      smokeGetEndpoints: parseJsonStringArray(this.configService.get<string>('RELEASE_SMOKE_GET_ENDPOINTS'), 'RELEASE_SMOKE_GET_ENDPOINTS'),
      smokeSuite: nullable('RELEASE_SMOKE_SUITE'),
      migrationDatasource: this.configService.get<string>('RELEASE_MIGRATION_DATASOURCE')!,
      expandContractEnforce: this.configService.get<boolean>('RELEASE_EXPAND_CONTRACT_ENFORCE')!,
      dependencyChangePolicy: this.configService.get<'block' | 'ack'>('RELEASE_DEPENDENCY_CHANGE_POLICY')!,
      notifyWebhook: nullable('RELEASE_NOTIFY_WEBHOOK'),
      stagedActivation: this.configService.get<boolean>('RELEASE_STAGED_ACTIVATION')!,
      readinessUrl: nullable('RELEASE_READINESS_URL'),
      readinessTimeoutSeconds: this.configService.get<number>('RELEASE_READINESS_TIMEOUT_SECONDS')!,
      companyMigrations: this.configService.get<'off' | 'dry-run' | 'on'>('RELEASE_COMPANY_MIGRATIONS')!,
      companyBackupPolicy: this.configService.get<'create' | 'require-recent'>('RELEASE_COMPANY_BACKUP_POLICY')!,
      companyBackupMaxAgeHours: this.configService.get<number>('RELEASE_COMPANY_BACKUP_MAX_AGE_HOURS')!,
    };
  }
}

/** Parses a JSON string array config value; a malformed value is a loud error, never a silent `[]`. */
function parseJsonStringArray(raw: string | undefined, key: string): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config ${key} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
    throw new Error(`Config ${key} must be a JSON array of strings.`);
  }
  return parsed as string[];
}
