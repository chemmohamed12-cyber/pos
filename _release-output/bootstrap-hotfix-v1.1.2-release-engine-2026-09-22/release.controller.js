"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReleaseController = void 0;
const common_1 = require("@nestjs/common");
const platform_express_1 = require("@nestjs/platform-express");
const multer_1 = require("multer");
const class_validator_1 = require("class-validator");
const data_repair_service_1 = require("./data-repair.service");
const deploy_preflight_service_1 = require("./deploy-preflight.service");
const typeorm_1 = require("typeorm");
const typeorm_2 = require("@nestjs/typeorm");
const crypto_1 = require("crypto");
const os_1 = require("os");
const promises_1 = require("fs/promises");
const backup_manager_service_1 = require("./backup-manager.service");
const restore_manager_service_1 = require("./restore-manager.service");
const release_manager_service_1 = require("./release-manager.service");
const release_execution_service_1 = require("./release-execution.service");
const backup_run_entity_1 = require("./backup-run.entity");
const backup_artifact_entity_1 = require("./backup-artifact.entity");
const restore_operation_entity_1 = require("./restore-operation.entity");
const release_entity_1 = require("./release.entity");
const release_migration_run_entity_1 = require("./release-migration-run.entity");
const app_version_1 = require("./app-version");
const build_info_1 = require("./build-info");
const app_config_service_1 = require("../configuration/app-config.service");
const jwt_auth_guard_1 = require("../authentication/jwt-auth.guard");
const roles_guard_1 = require("../authorization/roles.guard");
const require_role_decorator_1 = require("../authorization/require-role.decorator");
const permission_guard_1 = require("../permission/permission.guard");
const require_permission_decorator_1 = require("../permission/require-permission.decorator");
class RegisterReleaseDto {
    packageType;
    manifest;
}
__decorate([
    (0, class_validator_1.IsIn)(['full', 'delta']),
    __metadata("design:type", String)
], RegisterReleaseDto.prototype, "packageType", void 0);
__decorate([
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], RegisterReleaseDto.prototype, "manifest", void 0);
class LinkBackupDto {
    backupRunId;
}
__decorate([
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], LinkBackupDto.prototype, "backupRunId", void 0);
class CreateDataRepairDto {
    kind;
}
__decorate([
    (0, class_validator_1.IsIn)(['uuid_rfc4122']),
    __metadata("design:type", String)
], CreateDataRepairDto.prototype, "kind", void 0);
function redactErrorForResponse(value) {
    if (typeof value === 'string') {
        return value
            .replace(/(?:[A-Za-z]:)?(?:\/[\w.@+-]+){2,}/g, '<path>')
            .replace(/\s+/g, ' ')
            .slice(0, 400);
    }
    if (Array.isArray(value))
        return value.map(redactErrorForResponse);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = k === 'errorMessage' || k === 'error' ? redactErrorForResponse(v) : v;
        }
        return out;
    }
    return value;
}
let ReleaseController = class ReleaseController {
    backupManager;
    restoreManager;
    releaseManager;
    releaseExecution;
    dataRepair;
    deployPreflight;
    config;
    dataSource;
    constructor(backupManager, restoreManager, releaseManager, releaseExecution, dataRepair, deployPreflight, config, dataSource) {
        this.backupManager = backupManager;
        this.restoreManager = restoreManager;
        this.releaseManager = releaseManager;
        this.releaseExecution = releaseExecution;
        this.dataRepair = dataRepair;
        this.deployPreflight = deployPreflight;
        this.config = config;
        this.dataSource = dataSource;
    }
    async listBackups() {
        return redactErrorForResponse(await this.dataSource.getRepository(backup_run_entity_1.BackupRun).find({ order: { startedAt: 'DESC' }, take: 100 }));
    }
    async getBackup(id) {
        const run = await this.dataSource.getRepository(backup_run_entity_1.BackupRun).findOne({ where: { id } });
        const artifacts = await this.dataSource.getRepository(backup_artifact_entity_1.BackupArtifact).find({ where: { backupRunId: id } });
        return redactErrorForResponse({ run, artifacts });
    }
    async createBackup(req) {
        return redactErrorForResponse(await this.backupManager.createBackup('manual', req.user.id));
    }
    async reverifyBackupArtifact(artifactId) {
        return redactErrorForResponse(await this.backupManager.reverifyArtifact(artifactId));
    }
    async getRestore(id) {
        return this.dataSource.getRepository(restore_operation_entity_1.RestoreOperation).findOne({ where: { id } });
    }
    async preflightRestore(backupRunId, req) {
        return this.restoreManager.preflight(backupRunId, req.user.id);
    }
    async confirmRestore(id, req) {
        return this.restoreManager.confirmAndRestore(id, req.user.id);
    }
    async listReleases() {
        return this.dataSource.getRepository(release_entity_1.Release).find({ order: { uploadedAt: 'DESC' }, take: 100 });
    }
    async getRelease(id) {
        return this.dataSource.getRepository(release_entity_1.Release).findOne({ where: { id } });
    }
    async registerRelease(dto, req) {
        return this.releaseManager.registerRelease(dto.manifest, dto.packageType, req.user.id);
    }
    async linkReleaseBackup(id, dto, req) {
        return this.releaseManager.linkVerifiedBackup(id, dto.backupRunId, req.user.id);
    }
    async checkDeploymentGate(id) {
        return this.releaseManager.checkDeploymentGate(id);
    }
    async resolveUpgradePath(id) {
        return this.releaseManager.resolveUpgradePath(id);
    }
    async deployPreflightCheck() {
        return this.deployPreflight.runPreflight();
    }
    getVersion() {
        return { version: (0, app_version_1.readAppVersion)(), buildTag: (0, build_info_1.readBuildInfo)(this.config.releaseExecution.appRoot).buildTag };
    }
    async uploadRelease(file, packageType, req) {
        if (!file)
            throw new common_1.BadRequestException('No file uploaded — expected a multipart "file" field containing the release ZIP.');
        if (packageType !== 'full' && packageType !== 'delta') {
            await (0, promises_1.rm)(file.path, { force: true });
            throw new common_1.BadRequestException('packageType must be "full" or "delta".');
        }
        try {
            return await this.releaseExecution.uploadPackage(file.path, packageType, req.user.id);
        }
        finally {
            await (0, promises_1.rm)(file.path, { force: true });
        }
    }
    async deployRelease(id, req) {
        return this.releaseExecution.deployRelease(id, req.user.id);
    }
    async rollbackRelease(id, drill, req) {
        if (this.config.releaseDeploy.stagedActivation) {
            return this.releaseExecution.rollbackReleaseStaged(id, req.user.id, drill ? { drillName: drill } : {});
        }
        return this.releaseExecution.rollbackRelease(id, req.user.id);
    }
    async getReleaseRollbackReason(id) {
        return (await this.releaseExecution.readRollbackReason(id)) ?? { rollback_reason: null };
    }
    async getReleaseMigrations(id) {
        const repo = this.dataSource.getRepository(release_migration_run_entity_1.ReleaseMigrationRun);
        const latest = await repo.createQueryBuilder('r').where('r.releaseId = :id', { id }).select('MAX(r.startedAt)', 'max').getRawOne();
        if (!latest?.max)
            return [];
        return repo.find({ where: { releaseId: id, startedAt: latest.max }, order: { migrationName: 'ASC' } });
    }
    async listDataRepairs() {
        return this.dataRepair.list();
    }
    async getDataRepair(id) {
        return this.dataRepair.get(id);
    }
    async createDataRepair(dto, req) {
        return this.dataRepair.createAndAudit(dto.kind, req.user.id);
    }
    async planDataRepair(id) {
        return this.dataRepair.plan(id);
    }
    async linkDataRepairBackup(id, dto, req) {
        return this.dataRepair.linkVerifiedBackup(id, dto.backupRunId, req.user.id);
    }
    async executeDataRepair(id, req) {
        return this.dataRepair.execute(id, req.user.id);
    }
    async verifyDataRepairNow() {
        return this.dataRepair.verifyNow();
    }
};
exports.ReleaseController = ReleaseController;
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.view', 'read-only'),
    (0, common_1.Get)('backups'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "listBackups", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.view', 'read-only'),
    (0, common_1.Get)('backups/:id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "getBackup", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.backup', 'editable'),
    (0, common_1.Post)('backups'),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "createBackup", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.backup', 'editable'),
    (0, common_1.Post)('backups/artifacts/:artifactId/verify'),
    __param(0, (0, common_1.Param)('artifactId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "reverifyBackupArtifact", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.view', 'read-only'),
    (0, common_1.Get)('restores/:id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "getRestore", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.restore', 'editable'),
    (0, common_1.Post)('backups/:backupRunId/restore/preflight'),
    __param(0, (0, common_1.Param)('backupRunId')),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "preflightRestore", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.restore', 'editable'),
    (0, common_1.Post)('restores/:id/confirm'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "confirmRestore", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.view', 'read-only'),
    (0, common_1.Get)('releases'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "listReleases", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.view', 'read-only'),
    (0, common_1.Get)('releases/:id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "getRelease", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.deploy', 'editable'),
    (0, common_1.Post)('releases'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [RegisterReleaseDto, Object]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "registerRelease", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.deploy', 'editable'),
    (0, common_1.Post)('releases/:id/link-backup'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, LinkBackupDto, Object]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "linkReleaseBackup", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.deploy', 'read-only'),
    (0, common_1.Get)('releases/:id/deployment-gate'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "checkDeploymentGate", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.deploy', 'read-only'),
    (0, common_1.Get)('releases/:id/upgrade-path'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "resolveUpgradePath", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.deploy', 'read-only'),
    (0, common_1.Get)('preflight'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "deployPreflightCheck", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.view', 'read-only'),
    (0, common_1.Get)('version'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], ReleaseController.prototype, "getVersion", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.deploy', 'editable'),
    (0, common_1.Post)('releases/upload'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file', {
        storage: (0, multer_1.diskStorage)({ destination: (0, os_1.tmpdir)(), filename: (_req, _file, cb) => cb(null, `release-upload-${(0, crypto_1.randomUUID)()}.zip`) }),
        limits: { fileSize: 200 * 1024 * 1024 },
    })),
    __param(0, (0, common_1.UploadedFile)()),
    __param(1, (0, common_1.Body)('packageType')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "uploadRelease", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.deploy', 'editable'),
    (0, common_1.Post)('releases/:id/deploy'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "deployRelease", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.rollback', 'editable'),
    (0, common_1.Post)('releases/:id/rollback'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)('drill')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "rollbackRelease", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.view', 'read-only'),
    (0, common_1.Get)('releases/:id/rollback-reason'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "getReleaseRollbackReason", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.view', 'read-only'),
    (0, common_1.Get)('releases/:id/migrations'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "getReleaseMigrations", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.view', 'read-only'),
    (0, common_1.Get)('data-repairs'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "listDataRepairs", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.view', 'read-only'),
    (0, common_1.Get)('data-repairs/:id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "getDataRepair", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.restore', 'editable'),
    (0, common_1.Post)('data-repairs'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [CreateDataRepairDto, Object]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "createDataRepair", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.restore', 'editable'),
    (0, common_1.Post)('data-repairs/:id/plan'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "planDataRepair", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.restore', 'editable'),
    (0, common_1.Post)('data-repairs/:id/link-backup'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, LinkBackupDto, Object]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "linkDataRepairBackup", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.restore', 'editable'),
    (0, common_1.Post)('data-repairs/:id/execute'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "executeDataRepair", null);
__decorate([
    (0, common_1.UseGuards)(permission_guard_1.PermissionGuard),
    (0, require_permission_decorator_1.RequirePermission)('system.release.view', 'read-only'),
    (0, common_1.Get)('data-repairs/verify/now'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "verifyDataRepairNow", null);
exports.ReleaseController = ReleaseController = __decorate([
    (0, common_1.Controller)('release'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, roles_guard_1.RolesGuard),
    (0, require_role_decorator_1.RequireRole)('admin'),
    __param(7, (0, typeorm_2.InjectDataSource)()),
    __metadata("design:paramtypes", [backup_manager_service_1.BackupManagerService,
        restore_manager_service_1.RestoreManagerService,
        release_manager_service_1.ReleaseManagerService,
        release_execution_service_1.ReleaseExecutionService,
        data_repair_service_1.DataRepairService,
        deploy_preflight_service_1.DeployPreflightService,
        app_config_service_1.AppConfigService,
        typeorm_1.DataSource])
], ReleaseController);
//# sourceMappingURL=release.controller.js.map