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
}
