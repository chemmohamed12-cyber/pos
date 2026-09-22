"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var ReleaseExecutionService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReleaseExecutionService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const promises_1 = require("fs/promises");
const fs_1 = require("fs");
const path_1 = require("path");
const crypto_1 = require("crypto");
const release_entity_1 = require("./release.entity");
const release_migration_run_entity_1 = require("./release-migration-run.entity");
const package_validator_service_1 = require("./package-validator.service");
const release_manager_service_1 = require("./release-manager.service");
const release_health_check_service_1 = require("./release-health-check.service");
const deploy_preflight_service_1 = require("./deploy-preflight.service");
const restore_manager_service_1 = require("./restore-manager.service");
const staged_activation_service_1 = require("./staged-activation.service");
const lkg_registry_service_1 = require("./lkg-registry.service");
const build_info_1 = require("./build-info");
const expand_contract_guard_1 = require("./expand-contract-guard");
const migration_datasource_1 = require("./migration-datasource");
const migration_preflight_1 = require("./migration-preflight");
const app_version_1 = require("./app-version");
const app_config_service_1 = require("../configuration/app-config.service");
const audit_service_1 = require("../audit/audit.service");
const enabled_modules_1 = require("../../database/enabled-modules");
const manifest_verify_1 = require("../entitlement/manifest-verify");
const canonicalize_1 = require("../entitlement/canonicalize");
const installation_fingerprint_1 = require("../entitlement/installation-fingerprint");
const module_lifecycle_service_1 = require("../module-lifecycle/module-lifecycle.service");
class PreSwapAbort extends Error {
    constructor(message) {
        super(message);
        this.name = 'PreSwapAbort';
    }
}
let ReleaseExecutionService = ReleaseExecutionService_1 = class ReleaseExecutionService {
    dataSource;
    config;
    packageValidator;
    releaseManager;
    healthCheck;
    restoreManager;
    preflight;
    stagedActivation;
    lkg;
    audit;
    moduleLifecycle;
    logger = new common_1.Logger(ReleaseExecutionService_1.name);
    constructor(dataSource, config, packageValidator, releaseManager, healthCheck, restoreManager, preflight, stagedActivation, lkg, audit, moduleLifecycle) {
        this.dataSource = dataSource;
        this.config = config;
        this.packageValidator = packageValidator;
        this.releaseManager = releaseManager;
        this.healthCheck = healthCheck;
        this.restoreManager = restoreManager;
        this.preflight = preflight;
        this.stagedActivation = stagedActivation;
        this.lkg = lkg;
        this.audit = audit;
        this.moduleLifecycle = moduleLifecycle;
    }
    stagingDirFor(releaseId) {
        return (0, path_1.join)(this.config.releaseExecution.stagingPath, releaseId);
    }
    snapshotDirFor(releaseId) {
        return (0, path_1.join)(this.config.releaseBackup.storagePath, 'app-snapshots', releaseId);
    }
    resolveAppDestination(appRoot, relativePath) {
        const resolvedRoot = (0, path_1.resolve)(appRoot);
        const destPath = (0, path_1.resolve)((0, path_1.join)(appRoot, relativePath));
        const isAllowed = package_validator_service_1.ALLOWED_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) || package_validator_service_1.ALLOWED_ROOT_FILES.includes(relativePath);
        if (!isAllowed || (destPath !== resolvedRoot && !destPath.startsWith(resolvedRoot + path_1.sep))) {
            throw new common_1.ConflictException(`Refusing to deploy file outside allowed application paths: "${relativePath}".`);
        }
        return destPath;
    }
    async uploadPackage(zipFilePath, packageType, uploadedByUserId) {
        const tempStagingDir = (0, path_1.join)(this.config.releaseExecution.stagingPath, `upload-${(0, crypto_1.randomUUID)()}`);
        const result = await this.packageValidator.validateAndStage(zipFilePath, tempStagingDir, packageType);
        if (!result.manifest) {
            await this.audit.record({
                actorUserId: uploadedByUserId,
                organizationId: null,
                action: 'release.upload.rejected',
                resource: 'release',
                resourceId: null,
                result: 'denied',
                correlationId: null,
                after: { packageType, errors: result.errors },
            });
            throw new common_1.ConflictException(`Package rejected: ${result.errors.join('; ')}`);
        }
        const release = await this.releaseManager.registerRelease(result.manifest, packageType, uploadedByUserId);
        if (!result.ok) {
            const releaseRepo = this.dataSource.getRepository(release_entity_1.Release);
            release.status = 'validation_failed';
            release.errorMessage = [release.errorMessage, ...result.errors].filter(Boolean).join('; ');
            release.completedAt = new Date();
            await releaseRepo.save(release);
            return release;
        }
        const finalStagingDir = this.stagingDirFor(release.id);
        await (0, promises_1.mkdir)((0, path_1.dirname)(finalStagingDir), { recursive: true });
        await (0, promises_1.rm)(finalStagingDir, { recursive: true, force: true });
        await this.renameOrCopy(tempStagingDir, finalStagingDir);
        return release;
    }
    async renameOrCopy(from, to) {
        try {
            await (0, promises_1.rename)(from, to);
        }
        catch {
            await (0, promises_1.cp)(from, to, { recursive: true });
            await (0, promises_1.rm)(from, { recursive: true, force: true });
        }
    }
    async deployRelease(releaseId, actorUserId) {
        const releaseRepo = this.dataSource.getRepository(release_entity_1.Release);
        const release = await releaseRepo.findOne({ where: { id: releaseId } });
        if (!release)
            throw new common_1.NotFoundException(`Release "${releaseId}" not found.`);
        if (release.status !== 'backup_verified') {
            throw new common_1.ConflictException(`Release is "${release.status}" — only a "backup_verified" release (validated + linked to a verified backup) can be deployed.`);
        }
        await this.releaseManager.checkDeploymentGate(releaseId);
        const stagingDir = this.stagingDirFor(releaseId);
        const stagingExists = await (0, promises_1.stat)(stagingDir)
            .then((s) => s.isDirectory())
            .catch(() => false);
        if (!stagingExists) {
            throw new common_1.ConflictException('No staged package files found for this release — upload it via the ZIP upload endpoint (not the JSON-only registration endpoint) before deploying.');
        }
        const preflight = await this.preflight.runPreflight(stagingDir);
        await this.audit.record({
            actorUserId,
            organizationId: null,
            action: 'release.deploy.preflight',
            resource: 'release',
            resourceId: release.id,
            result: preflight.ok ? 'success' : 'denied',
            correlationId: null,
            after: { checks: preflight.checks },
        });
        if (!preflight.ok) {
            const failed = preflight.checks.filter((c) => c.status === 'fail').map((c) => `${c.name}: ${c.detail}`);
            throw new common_1.ConflictException(`Deploy preflight failed — ${failed.join(' | ')}`);
        }
        const { appRoot } = this.config.releaseExecution;
        release.status = 'deploying';
        await releaseRepo.save(release);
        await this.audit.record({
            actorUserId,
            organizationId: null,
            action: 'release.deploy.started',
            resource: 'release',
            resourceId: release.id,
            result: 'success',
            correlationId: null,
            after: { mode: this.config.releaseDeploy.stagedActivation ? 'staged' : 'legacy' },
        });
        if (this.config.releaseDeploy.stagedActivation) {
            return await this.deployReleaseStaged(release, stagingDir, actorUserId);
        }
        try {
            await this.snapshotBeforeDeploy(release, appRoot);
            await this.deployFiles(release, stagingDir, appRoot);
            release.status = 'migrating';
            await releaseRepo.save(release);
            await this.runReleaseMigrations(release, appRoot);
            release.status = 'health_checking';
            await releaseRepo.save(release);
            const health = await this.healthCheck.check();
            if (!health.ok) {
                throw new Error(`Post-deploy health check failed: ${JSON.stringify(health.detail)}`);
            }
            await this.triggerPassengerRestart(release.id, actorUserId, 'deploy');
            release.status = 'succeeded';
            release.completedAt = new Date();
            await releaseRepo.save(release);
            await this.audit.record({
                actorUserId,
                organizationId: null,
                action: 'release.deploy.succeeded',
                resource: 'release',
                resourceId: release.id,
                result: 'success',
                correlationId: null,
            });
            return release;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(`Deploy failed for release "${release.id}"`, err instanceof Error ? err.stack : message);
            release.status = 'failed';
            release.errorMessage = message;
            await releaseRepo.save(release);
            await this.audit.record({
                actorUserId,
                organizationId: null,
                action: 'release.deploy.failed',
                resource: 'release',
                resourceId: release.id,
                result: 'failure',
                correlationId: null,
                after: { error: message },
            });
            await this.rollbackRelease(releaseId, actorUserId);
            const finalRelease = await releaseRepo.findOneOrFail({ where: { id: releaseId } });
            return finalRelease;
        }
    }
    async deployReleaseStaged(release, stagingDir, actorUserId) {
        const releaseRepo = this.dataSource.getRepository(release_entity_1.Release);
        const audit = (action, result, after) => this.audit.record({ actorUserId, organizationId: null, action, resource: 'release', resourceId: release.id, result, correlationId: null, after });
        if (release.manifest.dependencyChanges && Object.keys(release.manifest.dependencyChanges).length > 0) {
            const policy = this.config.releaseDeploy.dependencyChangePolicy;
            release.status = 'failed';
            release.errorMessage =
                `This delta changes dependencies (${Object.keys(release.manifest.dependencyChanges).join(', ')}). ` +
                    `RELEASE_DEPENDENCY_CHANGE_POLICY=${policy}: the atomic swap does not cover a shared-nodevenv install. ` +
                    (policy === 'block' ? 'Refused.' : 'Requires the nodevenv-install flow + explicit operator acknowledgement.');
            await releaseRepo.save(release);
            await audit('release.deploy.dependency_change_blocked', 'denied', { policy, dependencyChanges: release.manifest.dependencyChanges });
            return release;
        }
        let candidatePath;
        let previousPath;
        let swapped = false;
        let entitlementApplied = null;
        const migrationHeadBefore = await this.getMigrationHead();
        try {
            candidatePath = await this.stagedActivation.buildCandidate(release.id, release.manifest, stagingDir);
            const verification = await this.stagedActivation.verifyCandidate(candidatePath);
            await audit('release.deploy.candidate_verified', verification.ok ? 'success' : 'denied', { checks: verification.checks });
            if (!verification.ok) {
                throw new PreSwapAbort(`CANDIDATE verification failed: ${verification.checks.filter((c) => c.status === 'fail').map((c) => `${c.name} (${c.detail})`).join('; ')}`);
            }
            entitlementApplied = await this.applyEntitlementManifestPreSwap(release, candidatePath, actorUserId);
            const migrationTags = entitlementApplied
                ? await this.resolveEntitlementTags(this.config.releaseExecution.appRoot)
                : undefined;
            const preflightReport = await (0, migration_preflight_1.buildMigrationPreflight)({
                candidatePath,
                database: this.config.database,
                nodeBin: this.config.releaseBuild.nodeBin,
                liveDataSource: this.dataSource,
                tags: migrationTags,
                manifestFiles: release.manifest.files,
                packageType: release.manifest.packageType,
                baseVersion: release.manifest.baseVersion,
                minimumCompatibleVersion: release.manifest.minimumCompatibleVersion,
                manifestDatabase: release.manifest.database,
                currentInstalledVersion: (0, app_version_1.readAppVersion)(),
            });
            await audit('release.deploy.migration_preflight', preflightReport.decision === 'READY_TO_ACTIVATE' ? 'success' : 'denied', {
                current: preflightReport.current,
                target: preflightReport.target,
                requiredCount: preflightReport.required.length,
                pending: preflightReport.pending,
                tagsInScope: preflightReport.tagsInScope,
                tagDriftIssues: preflightReport.tagDriftIssues,
                manifestDriftIssues: preflightReport.manifestDriftIssues,
                dependencyIssues: preflightReport.dependencyIssues,
                compatibility: preflightReport.compatibility,
                decision: preflightReport.decision,
            });
            this.logger.log((0, migration_preflight_1.formatMigrationPreflight)(preflightReport));
            if (preflightReport.decision === 'BLOCKED') {
                throw new PreSwapAbort((0, migration_preflight_1.formatMigrationPreflight)(preflightReport));
            }
            const contraction = await this.scanDeltaMigrations(release, candidatePath, migrationTags);
            if (contraction.length > 0) {
                const detail = contraction.map((v) => `${v.file}: ${v.rule} [${v.statement}]`).join(' | ');
                await audit('release.deploy.expand_contract_violation', 'denied', { violations: contraction });
                throw new PreSwapAbort(`Migration(s) are not expand/contract-safe: ${detail}`);
            }
            release.status = 'migrating';
            await releaseRepo.save(release);
            await this.runReleaseMigrations(release, candidatePath, migrationTags);
            const stillPending = await this.verifyMigrationsComplete(release, candidatePath, migrationTags);
            if (stillPending.length > 0) {
                await audit('release.deploy.migration_verification_failed', 'denied', { stillPending });
                throw new PreSwapAbort(`Migration phase reported success but ${stillPending.length} migration(s) this release ships are still pending: ${stillPending.join(', ')}. Refusing to swap.`);
            }
            const res = await this.stagedActivation.activate(release.id, candidatePath);
            previousPath = res.previousPath;
            swapped = true;
            await audit('release.deploy.swapped', 'success', { previousPath, activePath: res.activePath });
            await this.triggerPassengerRestart(release.id, actorUserId, 'deploy');
            release.status = 'health_checking';
            await releaseRepo.save(release);
            const health = await this.healthCheck.check();
            if (!health.ok)
                throw new Error(`Post-swap health check failed: ${JSON.stringify(health.detail)}`);
            const smokeFailures = await this.runSmokeGet();
            if (smokeFailures.length > 0)
                throw new Error(`Post-swap smoke failed: ${smokeFailures.join('; ')}`);
            if (entitlementApplied) {
                await this.enableModulesPostSwap(entitlementApplied, actorUserId);
                await audit('release.deploy.entitlement_applied', 'success', {
                    edition: entitlementApplied.manifest.edition_code,
                    modules: entitlementApplied.manifest.module_codes,
                });
            }
            await this.commitLkg(release, previousPath, migrationHeadBefore);
            await this.stagedActivation.pruneSlots([release.id]);
            release.status = 'succeeded';
            release.completedAt = new Date();
            await releaseRepo.save(release);
            await audit('release.deploy.succeeded', 'success', { swapped: true });
            return release;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(`Staged deploy failed for release "${release.id}" (swapped=${swapped})`, err instanceof Error ? err.stack : message);
            release.status = 'failed';
            release.errorMessage = message;
            await releaseRepo.save(release);
            await audit('release.deploy.failed', 'failure', { error: message, swapped });
            if (!swapped) {
                if (candidatePath)
                    await (0, promises_1.rm)(candidatePath, { recursive: true, force: true }).catch(() => undefined);
                if (entitlementApplied)
                    await this.restoreEntitlementManifest(entitlementApplied.prevText);
                return release;
            }
            return await this.rollbackAfterSwap(release, actorUserId, migrationHeadBefore, message, entitlementApplied?.prevText ?? undefined);
        }
    }
    async rollbackAfterSwap(release, actorUserId, migrationHeadBefore, failedGate, entitlementPrevText) {
        const releaseRepo = this.dataSource.getRepository(release_entity_1.Release);
        const audit = (action, result, after) => this.audit.record({ actorUserId, organizationId: null, action, resource: 'release', resourceId: release.id, result, correlationId: null, after });
        try {
            await this.stagedActivation.rollbackSwap(release.id);
        }
        catch (err) {
            if (err instanceof staged_activation_service_1.RollbackFailedSafeError)
                return await this.raiseFailedSafe(release, actorUserId, `swap rollback (${err.stage}): ${err.message}`);
            throw err;
        }
        try {
            await this.undoReleaseMigrations(release, actorUserId, migrationHeadBefore);
        }
        catch (err) {
            return await this.raiseFailedSafe(release, actorUserId, `migration undo / backup restore failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (entitlementPrevText !== undefined) {
            await this.restoreEntitlementManifest(entitlementPrevText);
            await this.moduleLifecycle?.reloadEntitlement().catch(() => undefined);
        }
        await this.triggerPassengerRestart(release.id, actorUserId, 'rollback');
        const health = await this.healthCheck.check().catch(() => ({ ok: false, detail: 'health check threw' }));
        await this.writeRollbackReason(release.id, failedGate, release.errorMessage);
        release.status = 'rolled_back';
        release.completedAt = new Date();
        await releaseRepo.save(release);
        await audit('release.rollback.completed', 'success', { restoredHealthOk: health.ok, rollbackReason: failedGate, mode: 'staged' });
        return release;
    }
    async raiseFailedSafe(release, actorUserId, detail) {
        const releaseRepo = this.dataSource.getRepository(release_entity_1.Release);
        release.status = 'failed_safe';
        release.errorMessage = `FAILED-SAFE: ${detail}. The runtime may be indeterminate — manual intervention required. DO NOT deploy again until resolved.`;
        release.completedAt = new Date();
        await releaseRepo.save(release);
        const logDir = (0, path_1.join)(this.config.releaseDeploy.manifestsPath, '..', 'logs', release.id);
        await (0, promises_1.mkdir)(logDir, { recursive: true }).catch(() => undefined);
        await (0, promises_1.writeFile)((0, path_1.join)(logDir, 'FAILED-SAFE'), `${new Date().toISOString()}\nrelease ${release.id} (${release.version})\n${detail}\n`).catch(() => undefined);
        await this.audit.record({
            actorUserId,
            organizationId: null,
            action: 'release.rollback.failed_safe',
            resource: 'release',
            resourceId: release.id,
            result: 'failure',
            correlationId: null,
            after: { detail },
        });
        const webhook = this.config.releaseDeploy.notifyWebhook;
        if (webhook) {
            await fetch(webhook, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ event: 'release.failed_safe', releaseId: release.id, version: release.version, detail, at: new Date().toISOString() }),
            }).catch((e) => this.logger.error(`FAILED-SAFE webhook POST failed: ${e instanceof Error ? e.message : String(e)}`));
        }
        this.logger.error(`FAILED-SAFE for release ${release.id}: ${detail}`);
        return release;
    }
    async rollbackReleaseStaged(releaseId, actorUserId, opts = {}) {
        const releaseRepo = this.dataSource.getRepository(release_entity_1.Release);
        const release = await releaseRepo.findOne({ where: { id: releaseId } });
        if (!release)
            throw new common_1.NotFoundException(`Release "${releaseId}" not found.`);
        await this.audit.record({ actorUserId, organizationId: null, action: 'release.rollback.started', resource: 'release', resourceId: release.id, result: 'success', correlationId: null, after: { mode: 'staged', drill: opts.drillName ?? null } });
        const lkg = await this.lkg.read();
        if (!lkg || lkg.current.release_id !== releaseId) {
            return await this.rollbackRelease(releaseId, actorUserId);
        }
        const migrationHeadBefore = await this.getMigrationHead();
        try {
            await this.stagedActivation.rollbackSwap(releaseId);
        }
        catch (err) {
            if (err instanceof staged_activation_service_1.RollbackFailedSafeError)
                return await this.raiseFailedSafe(release, actorUserId, `swap rollback (${err.stage}): ${err.message}`);
            throw err;
        }
        try {
            await this.undoReleaseMigrations(release, actorUserId, migrationHeadBefore);
        }
        catch (err) {
            return await this.raiseFailedSafe(release, actorUserId, `migration undo / backup restore failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.triggerPassengerRestart(release.id, actorUserId, 'rollback');
        await this.lkg.popOnRollback({ revertedReleaseId: releaseId, preDeployBackupRunId: lkg.history[0]?.backup_run_id ?? release.backupRunId, version: release.version, migrationHead: migrationHeadBefore });
        const reason = opts.drillName ? `drill:${opts.drillName}` : 'operator';
        await this.writeRollbackReason(releaseId, reason, opts.drillName ? null : release.errorMessage);
        release.status = 'rolled_back';
        release.errorMessage = opts.drillName ? null : release.errorMessage;
        release.completedAt = new Date();
        await releaseRepo.save(release);
        await this.audit.record({ actorUserId, organizationId: null, action: 'release.rollback.completed', resource: 'release', resourceId: release.id, result: 'success', correlationId: null, after: { mode: 'staged', rollbackReason: reason } });
        return release;
    }
    async undoReleaseMigrations(release, actorUserId, _migrationHeadBefore) {
        const migrationRunRepo = this.dataSource.getRepository(release_migration_run_entity_1.ReleaseMigrationRun);
        const successfulRuns = await migrationRunRepo.find({ where: { releaseId: release.id, success: true }, order: { startedAt: 'DESC', id: 'DESC' } });
        if (successfulRuns.length === 0)
            return;
        const undoTags = await this.resolveEntitlementTags(this.config.releaseExecution.appRoot);
        const ds = (0, migration_datasource_1.createMigrationDataSource)(this.config.releaseExecution.appRoot, this.config.database, undoTags);
        await ds.initialize();
        try {
            for (const run of successfulRuns) {
                await ds.undoLastMigration();
                await this.audit.record({ actorUserId, organizationId: null, action: 'release.rollback.migration_undone', resource: 'release', resourceId: release.id, result: 'success', correlationId: null, after: { migrationName: run.migrationName } });
            }
        }
        catch (err) {
            const ok = await this.fallbackFullRestore(release, actorUserId);
            if (!ok)
                throw err instanceof Error ? err : new Error(String(err));
        }
        finally {
            await ds.destroy();
        }
    }
    async commitLkg(release, previousPath, _migrationHeadBefore) {
        if (!(await this.lkg.isSeeded())) {
            await this.lkg.seed({ releaseId: 'bootstrap', version: release.version, backupRunId: release.backupRunId, migrationHead: _migrationHeadBefore });
        }
        await this.lkg.commit({
            release_id: release.id,
            version: release.version,
            delta_id: release.manifest.deltaId ?? null,
            activated_at: new Date().toISOString(),
            backup_run_id: release.backupRunId,
            prev_runtime_dir: previousPath,
            migration_head: await this.getMigrationHead(),
            build_tag: (0, build_info_1.readBuildInfo)(this.config.releaseExecution.appRoot).buildTag,
            verification: { verify_deploy: 'health ok', mode: 'staged' },
        });
    }
    async runSmokeGet() {
        const { healthBaseUrl, smokeGetEndpoints } = this.config.releaseDeploy;
        const failures = [];
        for (const path of smokeGetEndpoints) {
            const url = healthBaseUrl.replace(/\/$/, '') + path;
            try {
                const res = await fetch(url, { method: 'GET' });
                if (res.status === 401 || res.status === 403) {
                    failures.push(`${path} → HTTP ${res.status} — this endpoint requires authentication; ` +
                        `RELEASE_SMOKE_GET_ENDPOINTS must list only PUBLIC GET endpoints (e.g. /api/health, /api/health/db). ` +
                        `Fix the config — do not put an authenticated route here.`);
                }
                else if (!res.ok) {
                    failures.push(`${path} → HTTP ${res.status}`);
                }
            }
            catch (err) {
                failures.push(`${path} → ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return failures;
    }
    async scanDeltaMigrations(release, candidatePath, tags) {
        const migrationFiles = release.manifest.files.filter((f) => f.action !== 'delete' && (0, expand_contract_guard_1.isMigrationPath)(f.path));
        if (migrationFiles.length === 0)
            return [];
        const migrationDataSource = (0, migration_datasource_1.createMigrationDataSource)(candidatePath, this.config.database, tags);
        await migrationDataSource.initialize();
        let pendingNames;
        try {
            const executor = new typeorm_1.MigrationExecutor(migrationDataSource);
            const pending = await executor.getPendingMigrations();
            pendingNames = new Set(pending.map((m) => m.name));
            const { host, port, username, database } = this.config.database;
            const executed = await executor.getExecutedMigrations();
            this.logger.error(`[DIAG f064242d] scanDeltaMigrations connection=${username}@${host}:${port}/${database} ` +
                `migrationsLoaded=${migrationDataSource.migrations.length} executedCount=${executed.length} ` +
                `pendingCount=${pending.length} pendingNames=${JSON.stringify(pending.map((m) => m.name))}`);
        }
        finally {
            await migrationDataSource.destroy();
        }
        const pendingFiles = migrationFiles.filter((f) => {
            const base = f.path.replace(/\.(ts|js)$/, '').split('/').pop() ?? '';
            const i = base.indexOf('-');
            if (i < 0)
                return false;
            return pendingNames.has(base.slice(i + 1) + base.slice(0, i));
        });
        if (pendingFiles.length === 0)
            return [];
        const sources = [];
        for (const f of pendingFiles) {
            try {
                sources.push({ path: f.path, source: await (0, promises_1.readFile)((0, path_1.join)(candidatePath, f.path), 'utf8') });
            }
            catch {
            }
        }
        return (0, expand_contract_guard_1.scanForContraction)(sources);
    }
    async getMigrationHead() {
        try {
            const rows = await this.dataSource.query('SELECT name FROM migrations ORDER BY timestamp DESC, id DESC LIMIT 1');
            return rows[0]?.name ?? null;
        }
        catch {
            return null;
        }
    }
    async writeRollbackReason(releaseId, rollbackReason, errorMessage) {
        const p = (0, path_1.join)(this.config.releaseDeploy.manifestsPath, `rollback-${releaseId}.json`);
        await (0, promises_1.mkdir)((0, path_1.dirname)(p), { recursive: true }).catch(() => undefined);
        await (0, promises_1.writeFile)(p, JSON.stringify({ release_id: releaseId, rollback_reason: rollbackReason, error_message: errorMessage, reverted_at: new Date().toISOString() }, null, 2) + '\n').catch(() => undefined);
    }
    async readRollbackReason(releaseId) {
        try {
            const raw = await (await Promise.resolve().then(() => __importStar(require('fs/promises')))).readFile((0, path_1.join)(this.config.releaseDeploy.manifestsPath, `rollback-${releaseId}.json`), 'utf8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    async snapshotBeforeDeploy(release, appRoot) {
        const snapshotDir = this.snapshotDirFor(release.id);
        for (const file of release.manifest.files) {
            if (file.action === 'add')
                continue;
            const liveAbsolutePath = this.resolveAppDestination(appRoot, file.path);
            const exists = await (0, promises_1.stat)(liveAbsolutePath)
                .then(() => true)
                .catch(() => false);
            if (!exists)
                continue;
            const snapshotPath = (0, path_1.join)(snapshotDir, file.path);
            await (0, promises_1.mkdir)((0, path_1.dirname)(snapshotPath), { recursive: true });
            await (0, promises_1.copyFile)(liveAbsolutePath, snapshotPath);
        }
    }
    async deployFiles(release, stagingDir, appRoot) {
        for (const file of release.manifest.files) {
            const destPath = this.resolveAppDestination(appRoot, file.path);
            if (file.action === 'delete') {
                await (0, promises_1.rm)(destPath, { force: true });
                continue;
            }
            const sourcePath = (0, path_1.join)(stagingDir, file.path);
            await (0, promises_1.mkdir)((0, path_1.dirname)(destPath), { recursive: true });
            await (0, promises_1.copyFile)(sourcePath, destPath);
        }
    }
    async resolveEntitlementTags(appRoot) {
        const ent = this.config.entitlement;
        return (0, enabled_modules_1.readEnabledModules)({
            appRoot,
            dataSource: this.dataSource,
            publicKeys: ent?.publicKeys ?? [],
            mode: ent?.mode ?? 'unlicensed-full',
            clockToleranceMinutes: ent?.clockToleranceMinutes,
            logger: (m) => this.logger.warn(`[entitlement] ${m}`),
        });
    }
    entitlementFilePath() {
        return (0, path_1.join)(this.config.releaseExecution.appRoot, 'entitlement.manifest.json');
    }
    async applyEntitlementManifestPreSwap(release, candidatePath, actorUserId) {
        const ent = release.manifest.entitlement;
        if (!ent)
            return null;
        const manifestSrc = (0, path_1.join)(candidatePath, ent.manifestPath);
        let rawJson;
        try {
            rawJson = await (0, promises_1.readFile)(manifestSrc, 'utf8');
        }
        catch {
            throw new PreSwapAbort(`entitlement: manifest file "${ent.manifestPath}" not found in the package`);
        }
        const sigPath = ent.signaturePath ?? `${ent.manifestPath}.sig`;
        let signatureB64;
        try {
            signatureB64 = (await (0, promises_1.readFile)((0, path_1.join)(candidatePath, sigPath), 'utf8')).trim();
        }
        catch {
            throw new PreSwapAbort(`entitlement: signature file "${sigPath}" not found in the package`);
        }
        const cfg = this.config.entitlement;
        const result = (0, manifest_verify_1.verifyManifest)(rawJson, signatureB64, {
            publicKeys: cfg?.publicKeys ?? [],
            clockToleranceMinutes: cfg?.clockToleranceMinutes,
            currentFingerprint: (0, installation_fingerprint_1.computeInstallationFingerprint)(),
        });
        if (!result.ok) {
            await this.audit.record({
                actorUserId,
                organizationId: null,
                action: 'release.deploy.entitlement_rejected',
                resource: 'release',
                resourceId: release.id,
                result: 'denied',
                correlationId: null,
                after: { reason: result.reason, detail: result.detail },
            });
            throw new PreSwapAbort(`entitlement manifest rejected: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
        }
        const declared = new Set(ent.moduleCodes);
        const signed = new Set(result.manifest.module_codes);
        if (ent.moduleCodes.length && (declared.size !== signed.size || [...declared].some((c) => !signed.has(c)))) {
            throw new PreSwapAbort(`entitlement: release manifest moduleCodes [${[...declared].join(', ')}] disagree with the signed manifest [${[...signed].join(', ')}]`);
        }
        const target = this.entitlementFilePath();
        const prevText = (0, fs_1.existsSync)(target) ? await (0, promises_1.readFile)(target, 'utf8') : null;
        await (0, promises_1.writeFile)(target, (0, canonicalize_1.canonicalize)(result.manifest), 'utf8');
        await (0, promises_1.writeFile)(`${target}.sig`, signatureB64, 'utf8');
        await this.audit.record({
            actorUserId,
            organizationId: null,
            action: 'release.deploy.entitlement_manifest_written',
            resource: 'installation',
            resourceId: result.manifest.installation_id,
            result: 'success',
            correlationId: null,
            after: { edition: result.manifest.edition_code, version: result.manifest.edition_version, modules: result.manifest.module_codes },
        });
        return { manifest: result.manifest, signatureB64, prevText };
    }
    async enableModulesPostSwap(applied, actorUserId) {
        if (!this.moduleLifecycle) {
            this.logger.warn('entitlement: ModuleLifecycleService not available — installation row + module seeding skipped');
            return;
        }
        const r = await this.moduleLifecycle.applyEntitlementAndEnableModules(applied.manifest, applied.signatureB64, actorUserId);
        this.logger.log(`entitlement applied: edition ${applied.manifest.edition_code} v${applied.manifest.edition_version}` +
            (r.modulesAdded.length ? `, enabled module(s): ${r.modulesAdded.join(', ')}` : ', no new modules'));
    }
    async restoreEntitlementManifest(prevText) {
        const target = this.entitlementFilePath();
        try {
            if (prevText === null) {
                await (0, promises_1.rm)(target, { force: true });
                await (0, promises_1.rm)(`${target}.sig`, { force: true });
            }
            else {
                await (0, promises_1.writeFile)(target, prevText, 'utf8');
            }
        }
        catch (e) {
            this.logger.error(`entitlement: failed to restore ${target} on rollback: ${e.message}`);
        }
    }
    async runReleaseMigrations(release, appRoot, tags) {
        const migrationDataSource = (0, migration_datasource_1.createMigrationDataSource)(appRoot, this.config.database, tags);
        const migrationRunRepo = this.dataSource.getRepository(release_migration_run_entity_1.ReleaseMigrationRun);
        const startedAt = new Date();
        await migrationDataSource.initialize();
        let pendingNames = [];
        try {
            const pending = await new typeorm_1.MigrationExecutor(migrationDataSource).getPendingMigrations();
            pendingNames = pending.map((m) => m.name);
            await migrationDataSource.runMigrations();
            for (const name of pendingNames) {
                await migrationRunRepo.save(migrationRunRepo.create({
                    releaseId: release.id,
                    migrationName: name,
                    startedAt,
                    completedAt: new Date(),
                    success: true,
                    errorMessage: null,
                }));
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            for (const name of pendingNames) {
                await migrationRunRepo.save(migrationRunRepo.create({
                    releaseId: release.id,
                    migrationName: name,
                    startedAt,
                    completedAt: new Date(),
                    success: false,
                    errorMessage: message,
                }));
            }
            throw err;
        }
        finally {
            await migrationDataSource.destroy();
        }
    }
    async verifyMigrationsComplete(release, candidatePath, tags) {
        const shippedMigrationNames = new Set();
        for (const f of release.manifest.files) {
            if (f.action === 'delete' || !(0, expand_contract_guard_1.isMigrationPath)(f.path) || f.path.endsWith('.d.ts'))
                continue;
            const base = f.path.replace(/\.(ts|js)$/, '').split('/').pop() ?? '';
            const i = base.indexOf('-');
            if (i < 0)
                continue;
            shippedMigrationNames.add(base.slice(i + 1) + base.slice(0, i));
        }
        if (shippedMigrationNames.size === 0)
            return [];
        const migrationDataSource = (0, migration_datasource_1.createMigrationDataSource)(candidatePath, this.config.database, tags);
        await migrationDataSource.initialize();
        try {
            const pending = await new typeorm_1.MigrationExecutor(migrationDataSource).getPendingMigrations();
            const pendingNames = new Set(pending.map((m) => m.name));
            return [...shippedMigrationNames].filter((name) => pendingNames.has(name));
        }
        finally {
            await migrationDataSource.destroy();
        }
    }
    async rollbackRelease(releaseId, actorUserId) {
        const releaseRepo = this.dataSource.getRepository(release_entity_1.Release);
        const release = await releaseRepo.findOne({ where: { id: releaseId } });
        if (!release)
            throw new common_1.NotFoundException(`Release "${releaseId}" not found.`);
        await this.audit.record({
            actorUserId,
            organizationId: null,
            action: 'release.rollback.started',
            resource: 'release',
            resourceId: release.id,
            result: 'success',
            correlationId: null,
        });
        const { appRoot } = this.config.releaseExecution;
        const migrationRunRepo = this.dataSource.getRepository(release_migration_run_entity_1.ReleaseMigrationRun);
        const successfulRuns = await migrationRunRepo.find({ where: { releaseId, success: true }, order: { startedAt: 'DESC', id: 'DESC' } });
        let migrationUndoFailed = false;
        if (successfulRuns.length > 0) {
            const migrationDataSource = (0, migration_datasource_1.createMigrationDataSource)(appRoot, this.config.database);
            await migrationDataSource.initialize();
            try {
                for (const run of successfulRuns) {
                    await migrationDataSource.undoLastMigration();
                    await this.audit.record({
                        actorUserId,
                        organizationId: null,
                        action: 'release.rollback.migration_undone',
                        resource: 'release',
                        resourceId: release.id,
                        result: 'success',
                        correlationId: null,
                        after: { migrationName: run.migrationName },
                    });
                }
            }
            catch (err) {
                migrationUndoFailed = true;
                const message = err instanceof Error ? err.message : String(err);
                await this.audit.record({
                    actorUserId,
                    organizationId: null,
                    action: 'release.rollback.migration_undo_failed',
                    resource: 'release',
                    resourceId: release.id,
                    result: 'failure',
                    correlationId: null,
                    after: { error: message },
                });
            }
            finally {
                await migrationDataSource.destroy();
            }
        }
        if (migrationUndoFailed) {
            const fallbackOk = await this.fallbackFullRestore(release, actorUserId);
            if (!fallbackOk) {
                release.status = 'failed';
                release.errorMessage = 'Rollback failed: migration undo failed AND the fallback full database restore also failed. Manual intervention required.';
                await releaseRepo.save(release);
                await this.audit.record({
                    actorUserId,
                    organizationId: null,
                    action: 'release.rollback.failed',
                    resource: 'release',
                    resourceId: release.id,
                    result: 'failure',
                    correlationId: null,
                });
                return release;
            }
        }
        try {
            await this.restoreFilesFromSnapshot(release, appRoot);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            release.status = 'failed';
            release.errorMessage = `Rollback failed while restoring files: ${message}`;
            await releaseRepo.save(release);
            await this.audit.record({
                actorUserId,
                organizationId: null,
                action: 'release.rollback.failed',
                resource: 'release',
                resourceId: release.id,
                result: 'failure',
                correlationId: null,
                after: { error: message },
            });
            return release;
        }
        await this.triggerPassengerRestart(release.id, actorUserId, 'rollback');
        release.status = 'rolled_back';
        release.completedAt = new Date();
        await releaseRepo.save(release);
        await this.audit.record({
            actorUserId,
            organizationId: null,
            action: 'release.rollback.completed',
            resource: 'release',
            resourceId: release.id,
            result: 'success',
            correlationId: null,
            after: { usedFallbackFullRestore: migrationUndoFailed },
        });
        return release;
    }
    async fallbackFullRestore(release, actorUserId) {
        if (!release.backupRunId)
            return false;
        try {
            const preflight = await this.restoreManager.preflight(release.backupRunId, actorUserId);
            if (preflight.status !== 'pending_confirmation') {
                return false;
            }
            await this.restoreManager.confirmAndRestore(preflight.id, actorUserId);
            return true;
        }
        catch (err) {
            this.logger.error(`Fallback full restore failed for release "${release.id}"`, err instanceof Error ? err.stack : String(err));
            return false;
        }
    }
    async triggerPassengerRestart(releaseId, actorUserId, phase) {
        const restartFile = this.config.releaseExecution.passengerRestartFile;
        try {
            await (0, promises_1.mkdir)((0, path_1.dirname)(restartFile), { recursive: true });
            const exists = await (0, promises_1.stat)(restartFile)
                .then(() => true)
                .catch(() => false);
            if (exists) {
                const now = new Date();
                await (0, promises_1.utimes)(restartFile, now, now);
            }
            else {
                await (0, promises_1.writeFile)(restartFile, `restart requested by release ${releaseId} (${phase}) at ${new Date().toISOString()}\n`);
            }
            await this.audit.record({
                actorUserId,
                organizationId: null,
                action: 'release.deploy.restart_triggered',
                resource: 'release',
                resourceId: releaseId,
                result: 'success',
                correlationId: null,
                after: { phase, restartFile },
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Could not trigger Passenger restart for release "${releaseId}" (${phase}): ${message}. Restart the app manually from cPanel → Setup Node.js App → Restart.`);
            await this.audit.record({
                actorUserId,
                organizationId: null,
                action: 'release.deploy.restart_trigger_failed',
                resource: 'release',
                resourceId: releaseId,
                result: 'failure',
                correlationId: null,
                after: { phase, restartFile, error: message },
            });
        }
    }
    async restoreFilesFromSnapshot(release, appRoot) {
        const snapshotDir = this.snapshotDirFor(release.id);
        for (const file of release.manifest.files) {
            const liveAbsolutePath = this.resolveAppDestination(appRoot, file.path);
            if (file.action === 'add') {
                await (0, promises_1.rm)(liveAbsolutePath, { force: true });
                continue;
            }
            const snapshotPath = (0, path_1.join)(snapshotDir, file.path);
            const snapshotExists = await (0, promises_1.stat)(snapshotPath)
                .then(() => true)
                .catch(() => false);
            if (snapshotExists) {
                await (0, promises_1.mkdir)((0, path_1.dirname)(liveAbsolutePath), { recursive: true });
                await (0, promises_1.copyFile)(snapshotPath, liveAbsolutePath);
            }
            else {
                await (0, promises_1.rm)(liveAbsolutePath, { force: true });
            }
        }
    }
};
exports.ReleaseExecutionService = ReleaseExecutionService;
exports.ReleaseExecutionService = ReleaseExecutionService = ReleaseExecutionService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(10, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [typeorm_1.DataSource,
        app_config_service_1.AppConfigService,
        package_validator_service_1.PackageValidatorService,
        release_manager_service_1.ReleaseManagerService,
        release_health_check_service_1.ReleaseHealthCheckService,
        restore_manager_service_1.RestoreManagerService,
        deploy_preflight_service_1.DeployPreflightService,
        staged_activation_service_1.StagedActivationService,
        lkg_registry_service_1.LkgRegistryService,
        audit_service_1.AuditService,
        module_lifecycle_service_1.ModuleLifecycleService])
], ReleaseExecutionService);
//# sourceMappingURL=release-execution.service.js.map