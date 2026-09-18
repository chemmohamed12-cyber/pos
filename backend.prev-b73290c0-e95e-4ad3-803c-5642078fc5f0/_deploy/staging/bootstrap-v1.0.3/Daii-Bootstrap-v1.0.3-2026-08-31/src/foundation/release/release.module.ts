import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BackupRun } from './backup-run.entity';
import { BackupArtifact } from './backup-artifact.entity';
import { RestoreOperation } from './restore-operation.entity';
import { Release } from './release.entity';
import { ReleaseMigrationRun } from './release-migration-run.entity';
import { DataRepairRun } from './data-repair-run.entity';
import { PgDumpRunnerService } from './pg-dump-runner.service';
import { DataRepairService } from './data-repair.service';
import { DeployPreflightService } from './deploy-preflight.service';
import { BackupManagerService } from './backup-manager.service';
import { BackupSchedulerService } from './backup-scheduler.service';
import { RestoreManagerService } from './restore-manager.service';
import { ReleaseManagerService } from './release-manager.service';
import { PackageValidatorService } from './package-validator.service';
import { ReleaseHealthCheckService } from './release-health-check.service';
import { ReleaseExecutionService } from './release-execution.service';
import { ReleaseController } from './release.controller';
import { AuthenticationModule } from '../authentication/authentication.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { PermissionModule } from '../permission/permission.module';
import { AuditModule } from '../audit/audit.module';
import { ConfigurationModule } from '../configuration/configuration.module';

/**
 * Release Center — Phases A (Backup), B (Restore), C foundation slice
 * (Release/manifest tracking + the mandatory backup gate). Deliberately
 * under `foundation/` (not `domains/`) — this is a cross-cutting ops
 * capability, not a business domain, same tier as `foundation/media` /
 * `foundation/observability`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([BackupRun, BackupArtifact, RestoreOperation, Release, ReleaseMigrationRun, DataRepairRun]),
    AuthenticationModule,
    AuthorizationModule,
    PermissionModule,
    AuditModule,
    ConfigurationModule,
  ],
  controllers: [ReleaseController],
  providers: [
    PgDumpRunnerService,
    BackupManagerService,
    BackupSchedulerService,
    RestoreManagerService,
    ReleaseManagerService,
    PackageValidatorService,
    ReleaseHealthCheckService,
    ReleaseExecutionService,
    DataRepairService,
    DeployPreflightService,
  ],
  exports: [BackupManagerService, RestoreManagerService, ReleaseManagerService, ReleaseExecutionService, DataRepairService, DeployPreflightService],
})
export class ReleaseModule {}
