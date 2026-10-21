import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BackupRun } from './backup-run.entity';
import { BackupArtifact } from './backup-artifact.entity';
import { RestoreOperation } from './restore-operation.entity';
import { CompanyBackupSettings } from './company-backup-settings.entity';
import { BackupOperation } from './backup-operation.entity';
import { Release } from './release.entity';
import { ReleaseMigrationRun } from './release-migration-run.entity';
import { DataRepairRun } from './data-repair-run.entity';
import { PgDumpRunnerService } from './pg-dump-runner.service';
import { DataRepairService } from './data-repair.service';
import { DeployPreflightService } from './deploy-preflight.service';
import { BackupManagerService } from './backup-manager.service';
import { BackupSchedulerService } from './backup-scheduler.service';
import { BackupOperationService } from './backup-operation.service';
import { BackupReconciliationScheduler } from './backup-reconciliation.scheduler';
import { CompanyBaselineBackupScheduler } from './company-baseline-backup.scheduler';
import { RestoreManagerService } from './restore-manager.service';
import { ReleaseManagerService } from './release-manager.service';
import { PackageValidatorService } from './package-validator.service';
import { ReleaseHealthCheckService } from './release-health-check.service';
import { StagedActivationService } from './staged-activation.service';
import { LkgRegistryService } from './lkg-registry.service';
import { ReleaseExecutionService } from './release-execution.service';
import { CompanyFanoutService } from './company-fanout.service';
import { CompanyCatchUpService } from './company-catch-up.service';
import { ReleaseController } from './release.controller';
import { CompanyBackupController } from './company-backup.controller';
import { AuthenticationModule } from '../authentication/authentication.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { PermissionModule } from '../permission/permission.module';
import { AuditModule } from '../audit/audit.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { ModuleLifecycleModule } from '../module-lifecycle/module-lifecycle.module';
import { DatabaseRegistryModule } from '../database-registry/database-registry.module';
import { CompanyModule } from '../company/company.module';

/**
 * Release Center — Phases A (Backup), B (Restore), C foundation slice
 * (Release/manifest tracking + the mandatory backup gate). Deliberately
 * under `foundation/` (not `domains/`) — this is a cross-cutting ops
 * capability, not a business domain, same tier as `foundation/media` /
 * `foundation/observability`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([BackupRun, BackupArtifact, RestoreOperation, CompanyBackupSettings, BackupOperation, Release, ReleaseMigrationRun, DataRepairRun]),
    AuthenticationModule,
    AuthorizationModule,
    PermissionModule,
    AuditModule,
    ConfigurationModule,
    ModuleLifecycleModule,
    // Backup/DR Architecture V1 (2026-09-24, Track D) — DatabaseRegistryModule
    // for DatabaseRegistryService/CompanyConnectionManagerService (the
    // mandatory §9 connection chain), CompanyModule for CompanyService
    // (manifest's installationId lookup) and CompanyContextGuard
    // (CompanyBackupController's self-service path).
    DatabaseRegistryModule,
    CompanyModule,
  ],
  controllers: [ReleaseController, CompanyBackupController],
  providers: [
    PgDumpRunnerService,
    BackupManagerService,
    BackupSchedulerService,
    BackupOperationService,
    BackupReconciliationScheduler,
    CompanyBaselineBackupScheduler,
    RestoreManagerService,
    ReleaseManagerService,
    PackageValidatorService,
    ReleaseHealthCheckService,
    StagedActivationService,
    LkgRegistryService,
    ReleaseExecutionService,
    CompanyFanoutService,
    CompanyCatchUpService,
    DataRepairService,
    DeployPreflightService,
  ],
  exports: [BackupManagerService, RestoreManagerService, ReleaseManagerService, ReleaseExecutionService, CompanyFanoutService, StagedActivationService, LkgRegistryService, DataRepairService, DeployPreflightService],
})
export class ReleaseModule {}
