import { ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { DataSource, In, MigrationExecutor } from 'typeorm';
import { copyFile, cp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dirname, join, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import { Release } from './release.entity';
import { ReleaseMigrationRun } from './release-migration-run.entity';
import { PackageValidatorService, ALLOWED_PREFIXES, ALLOWED_ROOT_FILES } from './package-validator.service';
import { ReleaseManagerService } from './release-manager.service';
import { ReleaseHealthCheckService } from './release-health-check.service';
import { DeployPreflightService } from './deploy-preflight.service';
import { RestoreManagerService } from './restore-manager.service';
import { StagedActivationService, RollbackFailedSafeError } from './staged-activation.service';
import { LkgRegistryService } from './lkg-registry.service';
import { readBuildInfo } from './build-info';
import { scanForContraction, isMigrationPath } from './expand-contract-guard';
import { createMigrationDataSource } from './migration-datasource';
import { buildMigrationPreflight, formatMigrationPreflight } from './migration-preflight';
import { verifyArtifactIntegrity, formatArtifactIntegrityViolations } from './artifact-integrity';
import { readAppVersion } from './app-version';
import { ReleasePackageType } from './release-status';
import { AppConfigService } from '../configuration/app-config.service';
import { AuditService } from '../audit/audit.service';
import { readEnabledModules } from '../../database/enabled-modules';
import { verifyManifest } from '../entitlement/manifest-verify';
import { canonicalize } from '../entitlement/canonicalize';
import { EntitlementManifest } from '../entitlement/manifest.type';
import { computeInstallationFingerprint } from '../entitlement/installation-fingerprint';
import { ModuleLifecycleService } from '../module-lifecycle/module-lifecycle.service';
import { CompanyFanoutService, CompanyFanoutBlockedError, CompanyFanoutMode, CompanyFanoutPlan, CompanyFanoutResult, CompanyBackupEvidence, summarizePlan, summarizeResult } from './company-fanout.service';

/**
 * Release Center — Execution Layer. The orchestrator for the CTO
 * directive's exact pipeline: Upload -> Preflight/Validate -> Base
 * Version Check -> Verified Backup Gate -> Deploy Files -> Run
 * Migrations -> Health Check -> Success, or STOP -> Rollback -> Verify ->
 * Audit -> Failed/Rolled Back on any failure along the way.
 *
 * IMPORTANT technical note, not glossed over: the running NestJS
 * process's own injected `DataSource` resolved its `migrations` glob ONCE
 * at boot (`DataSource.buildMetadatas()`), so it can never see migration
 * files a release deploys onto disk mid-process-lifetime. Every migration
 * operation below (`runMigrations`/`undoLastMigration`) therefore opens
 * its OWN short-lived `DataSource`, scoped to `RELEASE_APP_ROOT`'s
 * CURRENT `dist/database/migrations` contents at the moment it's called,
 * and destroys it immediately after — this is what actually lets a
 * freshly-deployed migration run in the same request, with no process
 * restart in between.
 */
/** A CANDIDATE-verification / pre-swap failure — the deploy aborts with ACTIVE bit-for-bit untouched (Invariant I-2). */
class PreSwapAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreSwapAbort';
  }
}

const execFileAsync = promisify(execFile);

/**
 * A POST-swap readiness failure, classified (post-incident review of release 1.1.4: "file deployment" success is not "application started" is not "initialised"):
 *   `startup`        the restarted application did not answer 2xx on its health endpoints in time  -> APPLICATION_STARTUP_FAILED
 *   `initialization` the application answers but the platform is not initialised (no installation)  -> INITIALIZATION_FAILED
 * Thrown after the swap, so the existing automatic rollback (I-3) takes over.
 */
export class PostSwapReadinessError extends Error {
  constructor(
    readonly kind: 'startup' | 'initialization',
    message: string,
  ) {
    super(message);
    this.name = 'PostSwapReadinessError';
  }
}

export type DeployOutcome = 'DEPLOYMENT_VERIFIED' | 'DEPLOYED_UNVERIFIED' | 'DEPLOYMENT_FAILED' | 'APPLICATION_STARTUP_FAILED' | 'INITIALIZATION_FAILED' | 'POST_DEPLOYMENT_VALIDATION_FAILED';

@Injectable()
export class ReleaseExecutionService {
  private readonly logger = new Logger(ReleaseExecutionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
    private readonly packageValidator: PackageValidatorService,
    private readonly releaseManager: ReleaseManagerService,
    private readonly healthCheck: ReleaseHealthCheckService,
    private readonly restoreManager: RestoreManagerService,
    private readonly preflight: DeployPreflightService,
    private readonly stagedActivation: StagedActivationService,
    private readonly lkg: LkgRegistryService,
    private readonly audit: AuditService,
    /**
     * ERP Foundation P6 (T2). Optional so the many manual-construction unit
     * specs still compile; the real DI container always provides it
     * (`ModuleLifecycleModule` in `ReleaseModule`). Only used when a release
     * carries `manifest.entitlement`, which no pre-P6 test does.
     */
    @Optional() private readonly moduleLifecycle?: ModuleLifecycleService,
    /**
     * Company fan-out (CTO 2026-10-08). Optional for the same reason as `moduleLifecycle` (manual-construction unit specs); the real DI container always
     * provides it. Only consulted when `RELEASE_COMPANY_MIGRATIONS` is `dry-run` or `on`; with the default `off` no Company database is ever read or written.
     */
    @Optional() private readonly companyFanout?: CompanyFanoutService,
  ) {}

  /**
   * The effective fan-out mode. A configured `dry-run`/`on` with no fan-out service wired is a misconfiguration and fails LOUDLY — silently degrading to `off`
   * would deploy new code over Company databases the operator believed were being upgraded.
   */
  private companyFanoutMode(): CompanyFanoutMode {
    const configured = this.config.releaseDeploy?.companyMigrations;
    if (configured !== 'dry-run' && configured !== 'on') return 'off';
    if (!this.companyFanout) throw new Error(`RELEASE_COMPANY_MIGRATIONS=${configured} but no CompanyFanoutService is wired — refusing to deploy.`);
    return configured;
  }

  private stagingDirFor(releaseId: string): string {
    return join(this.config.releaseExecution.stagingPath, releaseId);
  }

  private snapshotDirFor(releaseId: string): string {
    return join(this.config.releaseBackup.storagePath, 'app-snapshots', releaseId);
  }

  /** Re-checked here too (belt-and-suspenders) even though `PackageValidatorService` already enforced this on every zip entry — this method trusts staging's prior work but re-derives the destination path independently rather than reusing anything unchecked. */
  private resolveAppDestination(appRoot: string, relativePath: string): string {
    const resolvedRoot = resolve(appRoot);
    const destPath = resolve(join(appRoot, relativePath));
    const isAllowed = ALLOWED_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) || ALLOWED_ROOT_FILES.includes(relativePath);
    if (!isAllowed || (destPath !== resolvedRoot && !destPath.startsWith(resolvedRoot + sep))) {
      throw new ConflictException(`Refusing to deploy file outside allowed application paths: "${relativePath}".`);
    }
    return destPath;
  }

  /**
   * Uploads + validates + stages a release ZIP. On success, the release
   * is registered as `'validated'` (or `'validation_failed'` if the
   * manifest itself is malformed) and the staging directory is kept,
   * keyed by the new release's id, for the later `deployRelease` call. On
   * a hard package-level failure (bad zip, checksum mismatch, undeclared
   * files, path-traversal attempt, etc.) the release is still recorded as
   * `'validation_failed'` with the full reason — never silently dropped —
   * and the staging directory is removed immediately.
   */
  async uploadPackage(zipFilePath: string, packageType: ReleasePackageType, uploadedByUserId: string): Promise<Release> {
    const tempStagingDir = join(this.config.releaseExecution.stagingPath, `upload-${randomUUID()}`);
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
      throw new ConflictException(`Package rejected: ${result.errors.join('; ')}`);
    }

    const release = await this.releaseManager.registerRelease(result.manifest, packageType, uploadedByUserId);

    if (!result.ok) {
      // Manifest shape was fine but staging-level checks failed (checksum
      // mismatch, undeclared file, path-traversal, etc.) — registerRelease
      // only re-runs the plain manifest-shape check, so force the correct
      // failed status here with the FULL error set, not just its subset.
      const releaseRepo = this.dataSource.getRepository(Release);
      release.status = 'validation_failed';
      release.errorMessage = [release.errorMessage, ...result.errors].filter(Boolean).join('; ');
      release.completedAt = new Date();
      await releaseRepo.save(release);
      return release;
    }

    // Staging succeeded — move it from its temp name to the release-id-keyed
    // location deployRelease will look for later.
    const finalStagingDir = this.stagingDirFor(release.id);
    await mkdir(dirname(finalStagingDir), { recursive: true });
    await rm(finalStagingDir, { recursive: true, force: true });
    await this.renameOrCopy(tempStagingDir, finalStagingDir);

    return release;
  }

  private async renameOrCopy(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch {
      await cp(from, to, { recursive: true });
      await rm(from, { recursive: true, force: true });
    }
  }

  /**
   * Boot-time self-reconciliation (Production Incident 2026-09-22).
   * `deployReleaseStaged()`'s post-swap sequence is: ATOMIC SWAP ->
   * `triggerPassengerRestart()` -> health check -> smoke check -> LKG
   * commit -> `release.status = 'succeeded'`. That restart trigger can
   * cause Passenger to recycle the CURRENT worker process — the same
   * process still executing the rest of that sequence — at any point
   * after it fires. When that happens, the deploy is functionally
   * complete (the swap already happened, the new code is what's now
   * running) but the function's own tail never gets to run: the release
   * row is permanently stuck at `health_checking` (or `migrating`/
   * `deploying`), even though nothing is actually wrong.
   *
   * This runs once at application boot (called from `main.ts`, after
   * `app.listen()`, fire-and-forget). A freshly-booted process is in the
   * exact right position to answer "did the deploy that produced ME
   * succeed?" — if a release row is stuck in an interrupted-deploy status
   * AND its version matches what THIS running process actually is AND a
   * real health check right now says healthy, that is direct, current
   * proof the deploy succeeded. It then finishes exactly the steps the
   * interrupted run never reached: LKG commit (skipped if the LKG's
   * current entry already names this release — never double-committed),
   * slot pruning, and the final status write — each one audited under
   * `release.deploy.reconciled`, never silent.
   *
   * Deliberately conservative: a version mismatch or a failed health
   * check leaves the row untouched — this never guesses, and never
   * fabricates a "succeeded" state the process itself can't verify right
   * now. Every failure here is caught and logged; it must never prevent
   * the application from finishing its own boot.
   */
  async reconcileInterruptedDeploys(actorUserId = 'system'): Promise<void> {
    const releaseRepo = this.dataSource.getRepository(Release);
    const stuck = await releaseRepo.find({ where: { status: In(['health_checking', 'migrating', 'deploying']) } });
    if (stuck.length === 0) return;

    const currentVersion = readAppVersion();
    for (const release of stuck) {
      if (release.version !== currentVersion) {
        this.logger.warn(
          `reconcileInterruptedDeploys: release "${release.id}" (v${release.version}) is stuck at "${release.status}" but this process is running v${currentVersion} — not reconciling (version mismatch, needs manual review).`,
        );
        continue;
      }
      try {
        const health = await this.healthCheck.check();
        if (!health.ok) {
          this.logger.warn(`reconcileInterruptedDeploys: release "${release.id}" matches this process's version but health check failed right now — leaving status as-is for manual review.`);
          continue;
        }

        const lkg = await this.lkg.read();
        if (!lkg || lkg.current.release_id !== release.id) {
          await this.commitLkg(release, '(unknown — reconciled after an interrupted deploy)', null);
          await this.stagedActivation.pruneSlots([release.id]);
        }

        const previousStatus = release.status;
        release.status = 'succeeded';
        release.completedAt = new Date();
        await releaseRepo.save(release);
        await this.audit.record({
          actorUserId,
          organizationId: null,
          action: 'release.deploy.reconciled',
          resource: 'release',
          resourceId: release.id,
          result: 'success',
          correlationId: null,
          after: {
            previousStatus,
            reason: 'boot-time self-check: this process is running the release version this row names, and reports healthy right now',
          },
        });
        this.logger.log(`reconcileInterruptedDeploys: release "${release.id}" (v${release.version}) reconciled from "${previousStatus}" to "succeeded".`);
      } catch (err) {
        this.logger.error(
          `reconcileInterruptedDeploys: failed for release "${release.id}" — left untouched for manual review.`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  /**
   * The full deploy pipeline. Stops immediately and triggers automatic
   * rollback on any failure from file-deploy onward; a gate failure (no
   * verified backup) stops before anything is touched at all.
   */
  async deployRelease(releaseId: string, actorUserId: string): Promise<Release> {
    const releaseRepo = this.dataSource.getRepository(Release);
    const release = await releaseRepo.findOne({ where: { id: releaseId } });
    if (!release) throw new NotFoundException(`Release "${releaseId}" not found.`);
    if (release.status !== 'backup_verified') {
      throw new ConflictException(`Release is "${release.status}" — only a "backup_verified" release (validated + linked to a verified backup) can be deployed.`);
    }

    // STOP condition: No Verified Backup -> No Deployment, re-checked live.
    await this.releaseManager.checkDeploymentGate(releaseId);

    const stagingDir = this.stagingDirFor(releaseId);
    const stagingExists = await stat(stagingDir)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!stagingExists) {
      throw new ConflictException('No staged package files found for this release — upload it via the ZIP upload endpoint (not the JSON-only registration endpoint) before deploying.');
    }

    // Host / environment readiness (binaries, disk, DB, staged-migration
    // hygiene) — every class of failure the v1.0.3 hand-deploy hit, turned
    // into an automated STOP before a single file is touched.
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
      throw new ConflictException(`Deploy preflight failed — ${failed.join(' | ')}`);
    }

    const { appRoot } = this.config.releaseExecution;

    // Company fan-out needs a pre-swap point to run in; only the staged path has one. Refuse BEFORE anything is touched (status still `backup_verified`).
    if (this.companyFanoutMode() !== 'off' && !this.config.releaseDeploy.stagedActivation) {
      throw new ConflictException('RELEASE_COMPANY_MIGRATIONS requires RELEASE_STAGED_ACTIVATION=true: the legacy in-place deploy has no pre-swap point at which to migrate Company databases.');
    }

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
    } catch (err) {
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

  // ─────────────────────────────────────────────────────────────────────
  // CTO-P3 — Staged Activation / Release Slots + CTO-P1 — LKG registry
  // (RELEASE_ENGINES_SPEC.md Pieces 2 + 3). Invariants I-1…I-4, I-6.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * The staged deploy: build a CANDIDATE slot → verify it in full → run
   * migrations (LATE, expand/contract) → ATOMIC SWAP → health + smoke →
   * COMMIT (write LKG, prune slots). A failure BEFORE the swap aborts with
   * ACTIVE bit-for-bit untouched (I-2). A failure AFTER the swap triggers a
   * controlled reverse-rename ROLLBACK (I-3); a rollback that itself fails
   * → FAILED-SAFE (I-4).
   */
  private async deployReleaseStaged(release: Release, stagingDir: string, actorUserId: string): Promise<Release> {
    const releaseRepo = this.dataSource.getRepository(Release);
    const audit = (action: string, result: 'success' | 'failure' | 'denied', after?: Record<string, unknown>) =>
      this.audit.record({ actorUserId, organizationId: null, action, resource: 'release', resourceId: release.id, result, correlationId: null, after });

    // Invariant I-9 — a dependency change is not covered by the atomic swap.
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

    let candidatePath: string | undefined;
    let previousPath: string | undefined;
    let swapped = false;
    let entitlementApplied: { manifest: EntitlementManifest; signatureB64: string; prevText: string | null } | null = null;
    const migrationHeadBefore = await this.getMigrationHead();
    const installationPresentBefore = await this.readInstallationPresent();
    let readiness: { status: 'verified' | 'unverified'; detail: Record<string, unknown> } = { status: 'unverified', detail: {} };
    let functional: { status: 'ok' | 'warning' | 'skipped'; detail: Record<string, unknown> } = { status: 'skipped', detail: { reason: 'application startup was not verified' } };
    // Company fan-out state (CTO 2026-10-08) — declared here so the failure audit below can report exactly who was migrated.
    const fanMode = this.companyFanoutMode();
    let fanPlan: CompanyFanoutPlan | null = null;
    let fanBackups: CompanyBackupEvidence[] = [];
    let fanResult: CompanyFanoutResult | null = null;

    try {
      // 1. build + verify CANDIDATE — nothing touches ACTIVE yet
      candidatePath = await this.stagedActivation.buildCandidate(release.id, release.manifest, stagingDir);
      const verification = await this.stagedActivation.verifyCandidate(candidatePath);
      await audit('release.deploy.candidate_verified', verification.ok ? 'success' : 'denied', { checks: verification.checks });
      if (!verification.ok) {
        throw new PreSwapAbort(`CANDIDATE verification failed: ${verification.checks.filter((c) => c.status === 'fail').map((c) => `${c.name} (${c.detail})`).join('; ')}`);
      }

      // 1a2. Production Incident 2026-09-22 — Artifact Integrity Gate.
      //      `verification` above proves the candidate is STRUCTURALLY
      //      sound (dist/main.js exists, JS parses, deps resolve) — it
      //      never proved the candidate's actual bytes are the ones the
      //      manifest (and therefore the operator's own upload) declares.
      //      A re-upload that registered correctly (manifestChecksum
      //      provably matched) still produced a candidate running old
      //      migration content — every build step traced clean from
      //      source, so this closes the gap by checking the one thing
      //      nothing else did: candidate bytes vs. manifest checksums,
      //      unconditionally, before migrations ever see this candidate.
      const integrity = await verifyArtifactIntegrity(release, candidatePath);
      await audit('release.deploy.artifact_integrity', integrity.ok ? 'success' : 'denied', { violations: integrity.violations });
      if (!integrity.ok) {
        throw new PreSwapAbort(formatArtifactIntegrityViolations(release.id, integrity.violations));
      }

      // 1a3. ENVIRONMENT - the new release must be able to start with THIS host's environment (it validates its own configuration at boot and exits otherwise,
      //      which Passenger shows as HTTP 503). Checked BEFORE the swap, so a missing variable aborts with ACTIVE untouched and the exact names instead.
      const envCheck = await this.verifyCandidateEnvironment(candidatePath);
      await audit('release.deploy.environment_check', envCheck.status === 'invalid' ? 'denied' : 'success', { status: envCheck.status, errors: envCheck.errors, ...(envCheck.detail ? { detail: envCheck.detail } : {}) });
      if (envCheck.status === 'invalid') {
        throw new PreSwapAbort(
          `ENVIRONMENT_INVALID: release ${release.version} cannot start with this host's environment - fix the host configuration first (cPanel > Setup Node.js App > environment variables): ${envCheck.errors.join(' | ')}`,
        );
      }

      // 1b. ERP Foundation P6 — apply the Edition entitlement manifest
      //     (verify signature, write entitlement.manifest.json) BEFORE the
      //     migration steps so they select Core + entitled-module tags only
      //     (ADR-025 §4.2). A bad signature aborts here, ACTIVE untouched.
      entitlementApplied = await this.applyEntitlementManifestPreSwap(release, candidatePath, actorUserId);
      const migrationTags = entitlementApplied
        ? await this.resolveEntitlementTags(this.config.releaseExecution.appRoot)
        : undefined;

      // 1c. CTO Directive (Production Incident 2026-09-15 post-mortem) — Migration Preflight is a
      // MANDATORY activation gate, not an informational display: it must produce exactly one of
      // READY_TO_ACTIVATE or BLOCKED, never a third "proceed with uncertainty" state. Runs BEFORE the
      // expand/contract scan and BEFORE any migration executes — ACTIVE is still bit-for-bit
      // untouched at this point (I-2), so a BLOCKED decision costs nothing to undo.
      const preflightReport = await buildMigrationPreflight({
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
        currentInstalledVersion: readAppVersion(),
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
      this.logger.log(formatMigrationPreflight(preflightReport));
      if (preflightReport.decision === 'BLOCKED') {
        throw new PreSwapAbort(formatMigrationPreflight(preflightReport));
      }

      // 1d. Company fan-out PLAN (CTO 2026-10-08). `off` (the default) is an audited, deliberate statement that no Company database is part of this deploy —
      //     nothing about any Company is read. `dry-run`/`on` discover the READY Companies and compute each one's tags + pending migrations (read-only). A READY
      //     Company that cannot be evaluated BLOCKS the deploy here, pre-swap, with ACTIVE untouched.
      if (fanMode === 'off') {
        await audit('release.deploy.company_fanout', 'success', { mode: 'off', note: 'Company databases are not part of this deployment (RELEASE_COMPANY_MIGRATIONS=off); none was read or written.' });
      } else {
        fanPlan = await this.companyFanout!.plan(candidatePath, migrationTags);
        await audit('release.deploy.company_fanout_plan', fanPlan.blockers.length === 0 ? 'success' : 'denied', summarizePlan(fanPlan));
        if (fanPlan.blockers.length > 0) throw new PreSwapAbort(`Company fan-out cannot proceed: ${fanPlan.blockers.join(' | ')}`);
        if (fanMode === 'dry-run') {
          await audit('release.deploy.company_fanout', 'success', { mode: 'dry-run', note: 'plan only; no backup taken, no Company touched', companiesWithPending: fanPlan.planned.filter((c) => c.pending.length > 0).map((c) => c.companyName) });
        }
      }

      // 2. Invariant I-8 — expand/contract migrations only. Scan the NEW
      //    migration files in this delta (from the verified CANDIDATE tree)
      //    for contraction DDL BEFORE running anything. A violation ALWAYS
      //    aborts pre-swap (I-2 preserved) — this is a correctness gate, not
      //    an advisory one. Production Incident 2026-09-22: this gate used
      //    to be skippable via `RELEASE_EXPAND_CONTRACT_ENFORCE=false`,
      //    which let a DENIED violation fall through to swap/restart/
      //    succeeded — a config value silently downgraded a safety
      //    invariant to a log line. There is no longer an escape hatch:
      //    a detected violation always throws, regardless of any config.
      const contraction = await this.scanDeltaMigrations(release, candidatePath, migrationTags);
      if (contraction.length > 0) {
        const detail = contraction.map((v) => `${v.file}: ${v.rule} [${v.statement}]`).join(' | ');
        await audit('release.deploy.expand_contract_violation', 'denied', { violations: contraction });
        throw new PreSwapAbort(`Migration(s) are not expand/contract-safe: ${detail}`);
      }

      // 2b. Company restore points (fan-out `on`) — taken/verified BEFORE any database (Platform included) is migrated, so a Company without one aborts the
      //     deploy while nothing at all has changed yet.
      if (fanMode === 'on' && fanPlan) {
        try {
          fanBackups = await this.companyFanout!.ensureBackups(fanPlan, actorUserId);
          await audit('release.deploy.company_backups', 'success', { policy: this.config.releaseDeploy.companyBackupPolicy, backups: fanBackups });
        } catch (err) {
          if (err instanceof CompanyFanoutBlockedError) {
            await audit('release.deploy.company_backups', 'denied', { policy: this.config.releaseDeploy.companyBackupPolicy, blockers: err.blockers });
            throw new PreSwapAbort(err.message);
          }
          throw err;
        }
      }

      // 3. migrations — LATE, against the CANDIDATE's compiled migration set, immediately before the swap
      release.status = 'migrating';
      await releaseRepo.save(release);
      await this.runReleaseMigrations(release, candidatePath, migrationTags);

      // 3a. Company fan-out (`on`) — Platform is migrated; now every applicable READY Company, one at a time, READY -> MIGRATING -> READY, stop at the first
      //     failure. Still PRE-SWAP: a failure here aborts with ACTIVE untouched, and Companies already migrated stay migrated (forward-only; expand-only
      //     migrations keep the still-active OLD code working against them).
      if (fanMode === 'on' && fanPlan) {
        fanResult = await this.companyFanout!.migrate(fanPlan, candidatePath, actorUserId, release.id, fanBackups);
        await audit('release.deploy.company_fanout', fanResult.ok ? 'success' : 'failure', { mode: 'on', ...summarizeResult(fanResult) });
        if (!fanResult.ok) {
          const s = summarizeResult(fanResult);
          throw new PreSwapAbort(
            `Company fan-out failed — migrated: [${(s.migrated as string[]).join(', ')}]; failed: ${JSON.stringify(s.failed)}; not attempted: [${(s.notAttempted as string[]).join(', ')}]. ` +
              'Refusing to swap. Companies already migrated remain migrated (forward-only, expand-only).',
          );
        }
        const companiesStillPending = await this.companyFanout!.verify(fanPlan, candidatePath);
        if (Object.keys(companiesStillPending).length > 0) {
          await audit('release.deploy.company_fanout_verification_failed', 'denied', { companiesStillPending });
          throw new PreSwapAbort(`Company fan-out reported success but ${Object.keys(companiesStillPending).length} Company(ies) still have pending migrations: ${JSON.stringify(companiesStillPending)}. Refusing to swap.`);
        }
        await audit('release.deploy.company_fanout_verified', 'success', { companies: fanResult.outcomes.map((o) => ({ company: o.companyName, status: o.status })) });
      }

      // 3b. Production Incident 2026-09-22 — migration EXECUTION completing
      //     without error was previously trusted as proof the release's own
      //     migrations actually ran. It isn't: a narrower-than-expected tag
      //     scope reaching `runReleaseMigrations` (whatever its cause) can
      //     make `runMigrations()` succeed having genuinely run zero of the
      //     migrations THIS release actually needs, with no error raised —
      //     the four `SeedAdminPermissionsFor*` migrations shipped in
      //     v1.1.1 and never executed on production are the proven case.
      //     Re-derive "is every migration this candidate's manifest ships
      //     now actually recorded as executed" from the SAME source of
      //     truth (`MigrationExecutor`, never a hand-rolled diff) as an
      //     independent post-condition — never inferred from "the call
      //     didn't throw". A non-empty result here means migration state is
      //     missing/inconsistent/uncertain: swap must not proceed.
      const stillPending = await this.verifyMigrationsComplete(release, candidatePath, migrationTags);
      if (stillPending.length > 0) {
        await audit('release.deploy.migration_verification_failed', 'denied', { stillPending });
        throw new PreSwapAbort(
          `Migration phase reported success but ${stillPending.length} migration(s) this release ships are still pending: ${stillPending.join(', ')}. Refusing to swap.`,
        );
      }

      // 4. ATOMIC SWAP
      const res = await this.stagedActivation.activate(release.id, candidatePath);
      previousPath = res.previousPath;
      swapped = true;
      await audit('release.deploy.swapped', 'success', { previousPath, activePath: res.activePath });
      await this.triggerPassengerRestart(release.id, actorUserId, 'deploy');

      // 5a. APPLICATION READINESS (startup, then functional) - post-swap; failure -> ROLLBACK (I-3). Verified over HTTP when RELEASE_READINESS_URL is set.
      release.status = 'health_checking';
      await releaseRepo.save(release);
      readiness = await this.verifyApplicationReadiness();
      if (readiness.status === 'verified') functional = await this.verifyFunctionalReadiness(installationPresentBefore);

      // 5. health + smoke — post-swap; failure → ROLLBACK
      release.status = 'health_checking';
      await releaseRepo.save(release);
      const health = await this.healthCheck.check();
      if (!health.ok) throw new Error(`Post-swap health check failed: ${JSON.stringify(health.detail)}`);
      const smokeFailures = await this.runSmokeGet();
      if (smokeFailures.length > 0) throw new Error(`Post-swap smoke failed: ${smokeFailures.join('; ')}`);

      // 5b. ERP Foundation P6 — write the `installation` row + seed every
      //     newly-entitled module's role templates / config keys / limit
      //     profiles. Post-swap so a seeding failure is a normal post-swap
      //     failure → I-3 rollback, same as a failed health check.
      if (entitlementApplied) {
        await this.enableModulesPostSwap(entitlementApplied, actorUserId);
        await audit('release.deploy.entitlement_applied', 'success', {
          edition: entitlementApplied.manifest.edition_code,
          modules: entitlementApplied.manifest.module_codes,
        });
      }

      // 6. COMMIT — LKG + prune
      await this.commitLkg(release, previousPath, migrationHeadBefore);
      await this.stagedActivation.pruneSlots([release.id]);

      release.status = 'succeeded';
      release.completedAt = new Date();
      await releaseRepo.save(release);
      const outcome: DeployOutcome = readiness.status === 'verified' ? 'DEPLOYMENT_VERIFIED' : 'DEPLOYED_UNVERIFIED';
      await audit('release.deploy.evidence', 'success', {
        outcome,
        engineVersion: readAppVersion(),
        releaseVersion: release.version,
        layers: {
          deployment: 'ok (files swapped, migrations verified, health check ok)',
          applicationStartup: readiness.status === 'verified' ? { status: 'verified', ...readiness.detail } : { status: 'UNVERIFIED', ...readiness.detail },
          functionalReadiness: functional,
        },
      });
      await audit('release.deploy.succeeded', 'success', { swapped: true, outcome });
      return release;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Staged deploy failed for release "${release.id}" (swapped=${swapped})`, err instanceof Error ? err.stack : message);
      release.status = 'failed';
      release.errorMessage = message;
      await releaseRepo.save(release);
      await audit('release.deploy.failed', 'failure', { error: message, swapped, outcome: ReleaseExecutionService.classifyFailure(err, swapped), ...(fanResult ? { companyFanout: summarizeResult(fanResult) } : {}) });

      if (!swapped) {
        // I-2 — nothing was promoted; ACTIVE is bit-for-bit unchanged.
        if (candidatePath) await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
        // migrations, if any ran, were rolled back by TypeORM's batch transaction.
        // P6: if we wrote a new entitlement.manifest.json before the abort, put it back.
        if (entitlementApplied) await this.restoreEntitlementManifest(entitlementApplied.prevText);
        return release;
      }

      // I-3 — post-swap failure → controlled ROLLBACK
      return await this.rollbackAfterSwap(release, actorUserId, migrationHeadBefore, message, entitlementApplied?.prevText ?? undefined);
    }
  }

  /** Post-swap automatic rollback (I-3) / FAILED-SAFE (I-4). */
  private async rollbackAfterSwap(
    release: Release,
    actorUserId: string,
    migrationHeadBefore: string | null,
    failedGate: string,
    entitlementPrevText?: string | null,
  ): Promise<Release> {
    const releaseRepo = this.dataSource.getRepository(Release);
    const audit = (action: string, result: 'success' | 'failure', after?: Record<string, unknown>) =>
      this.audit.record({ actorUserId, organizationId: null, action, resource: 'release', resourceId: release.id, result, correlationId: null, after });

    let failedSlotPath: string | undefined;
    try {
      failedSlotPath = (await this.stagedActivation.rollbackSwap(release.id))?.failedPath;
    } catch (err) {
      if (err instanceof RollbackFailedSafeError) return await this.raiseFailedSafe(release, actorUserId, `swap rollback (${err.stage}): ${err.message}`);
      throw err;
    }

    // undo migrations this release ran (or full restore); a failure here is also FAILED-SAFE
    try {
      await this.undoReleaseMigrations(release, actorUserId, migrationHeadBefore, failedSlotPath);
    } catch (err) {
      return await this.raiseFailedSafe(release, actorUserId, `migration undo / backup restore failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // P6: migrations are undone — now put entitlement.manifest.json back to
    // its pre-deploy state and re-resolve the Entitlement Engine cache.
    if (entitlementPrevText !== undefined) {
      await this.restoreEntitlementManifest(entitlementPrevText);
      await this.moduleLifecycle?.reloadEntitlement().catch(() => undefined);
    }

    await this.triggerPassengerRestart(release.id, actorUserId, 'rollback');
    const health = await this.healthCheck.check().catch(() => ({ ok: false, detail: 'health check threw' }));

    // LKG is NOT touched here: COMMIT (step 5) never ran, so the LKG still
    // correctly describes the now-restored ACTIVE (I-6 — a pre-COMMIT abort
    // leaves the LKG byte-unchanged). The "pop" belongs only to an explicit
    // rollback of an already-COMMITted release (rollbackReleaseStaged).
    await this.writeRollbackReason(release.id, failedGate, release.errorMessage);

    release.status = 'rolled_back';
    release.completedAt = new Date();
    await releaseRepo.save(release);
    await audit('release.rollback.completed', 'success', { restoredHealthOk: health.ok, rollbackReason: failedGate, mode: 'staged' });
    return release;
  }

  /** FAILED-SAFE terminal state (I-4) — STOP, alarm, never silently continue. */
  private async raiseFailedSafe(release: Release, actorUserId: string, detail: string): Promise<Release> {
    const releaseRepo = this.dataSource.getRepository(Release);
    release.status = 'failed_safe';
    release.errorMessage = `FAILED-SAFE: ${detail}. The runtime may be indeterminate — manual intervention required. DO NOT deploy again until resolved.`;
    release.completedAt = new Date();
    await releaseRepo.save(release);

    const logDir = join(this.config.releaseDeploy.manifestsPath, '..', 'logs', release.id);
    await mkdir(logDir, { recursive: true }).catch(() => undefined);
    await writeFile(join(logDir, 'FAILED-SAFE'), `${new Date().toISOString()}\nrelease ${release.id} (${release.version})\n${detail}\n`).catch(() => undefined);

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

  /** Explicit, operator-initiated rollback of an already-COMMITted release (staged path) — the LKG "pop". */
  async rollbackReleaseStaged(releaseId: string, actorUserId: string, opts: { drillName?: string } = {}): Promise<Release> {
    const releaseRepo = this.dataSource.getRepository(Release);
    const release = await releaseRepo.findOne({ where: { id: releaseId } });
    if (!release) throw new NotFoundException(`Release "${releaseId}" not found.`);

    await this.audit.record({ actorUserId, organizationId: null, action: 'release.rollback.started', resource: 'release', resourceId: release.id, result: 'success', correlationId: null, after: { mode: 'staged', drill: opts.drillName ?? null } });

    const lkg = await this.lkg.read();
    if (!lkg || lkg.current.release_id !== releaseId) {
      // Not the current LKG (older release, or unseeded) — fall back to the legacy snapshot rollback.
      return await this.rollbackRelease(releaseId, actorUserId);
    }

    const migrationHeadBefore = await this.getMigrationHead();
    let failedSlotPath: string | undefined;
    try {
      failedSlotPath = (await this.stagedActivation.rollbackSwap(releaseId))?.failedPath;
    } catch (err) {
      if (err instanceof RollbackFailedSafeError) return await this.raiseFailedSafe(release, actorUserId, `swap rollback (${err.stage}): ${err.message}`);
      throw err;
    }
    try {
      await this.undoReleaseMigrations(release, actorUserId, migrationHeadBefore, failedSlotPath);
    } catch (err) {
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

  /**
   * `migrationTreePath` — where to load the migration CLASSES from (H3 RB-1). On the staged path the
   * release's migrations ran from its CANDIDATE tree, and by the time undo runs `rollbackSwap` has already
   * put the PREVIOUS release back as ACTIVE (`appRoot`), which does not contain them — loading from
   * `appRoot` made TypeORM throw "No migration … was found" and forced the full-restore fallback. The two
   * staged callers therefore pass the FAILED slot (the rejected tree `rollbackSwap` just moved aside).
   * Omitted (legacy in-place path) → `appRoot`, unchanged. The tag set still comes from `appRoot`'s manifest.
   */
  private async undoReleaseMigrations(release: Release, actorUserId: string, _migrationHeadBefore: string | null, migrationTreePath?: string): Promise<void> {
    const migrationRunRepo = this.dataSource.getRepository(ReleaseMigrationRun);
    const successfulRuns = await migrationRunRepo.find({ where: { releaseId: release.id, success: true }, order: { startedAt: 'DESC', id: 'DESC' } });
    if (successfulRuns.length === 0) return;
    // ADR-025 / P6: undo must be able to load the same migration classes that
    // ran, so it uses the same tag set — resolved from whatever
    // entitlement.manifest.json is currently on disk (the NEW one during a
    // post-swap rollback, restored to the OLD one only AFTER this undo).
    const undoTags = await this.resolveEntitlementTags(this.config.releaseExecution.appRoot);
    const ds = createMigrationDataSource(migrationTreePath ?? this.config.releaseExecution.appRoot, this.config.database, undoTags);
    await ds.initialize();
    try {
      for (const run of successfulRuns) {
        await ds.undoLastMigration();
        await this.audit.record({ actorUserId, organizationId: null, action: 'release.rollback.migration_undone', resource: 'release', resourceId: release.id, result: 'success', correlationId: null, after: { migrationName: run.migrationName } });
      }
    } catch (err) {
      // last resort — full DB restore from the release's linked verified backup
      const ok = await this.fallbackFullRestore(release, actorUserId);
      if (!ok) throw err instanceof Error ? err : new Error(String(err));
    } finally {
      await ds.destroy();
    }
  }

  private async commitLkg(release: Release, previousPath: string, _migrationHeadBefore: string | null): Promise<void> {
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
      build_tag: readBuildInfo(this.config.releaseExecution.appRoot).buildTag,
      verification: { verify_deploy: 'health ok', mode: 'staged' },
    });
  }

  /**
   * Post-swap GET smoke. The requests carry **no Authorization header**, so
   * `RELEASE_SMOKE_GET_ENDPOINTS` must list ONLY public (unauthenticated)
   * GET endpoints — `/api/health`, `/api/health/db`, `/api/health/deep`.
   * A guarded endpoint (anything under `/api/release`, `/api/auth/me`, a
   * business route, …) returns 401/403 and would trip an unnecessary
   * post-swap ROLLBACK, so a 401/403 here is reported with an explicit
   * "endpoint requires auth — misconfiguration" hint rather than a bare
   * status code. The default is `[]` (no GET smoke); the in-process
   * `ReleaseHealthCheckService.check()` is the real post-swap gate.
   */
  /**
   * PRE-SWAP environment check (post-incident review of release 1.1.4, HTTP 503). A release validates ITS OWN configuration schema at boot and exits when the host's
   * environment lacks something it requires (1.1.4 newly required DATABASE_CREDENTIAL_ENCRYPTION_KEY in production; a host configured for 1.1.2 then answers 503 right
   * after the swap). The engine runs inside the same application, so its process environment IS what the new process will receive: validate the CANDIDATE's schema
   * against it BEFORE the swap and refuse with the exact names. Runs in a child process (the candidate's code never enters this one). A candidate without a schema file
   * (an older layout) is reported `skipped`, not passed.
   */
  private async verifyCandidateEnvironment(candidatePath: string): Promise<{ status: 'valid' | 'invalid' | 'skipped'; errors: string[]; detail?: string }> {
    const schemaFile = join(candidatePath, 'dist', 'foundation', 'configuration', 'configuration.schema.js');
    if (!existsSync(schemaFile)) return { status: 'skipped', errors: [], detail: 'candidate has no configuration schema file' };
    const script =
      "const m=require(process.argv[1]);const s=m.configurationValidationSchema;" +
      "if(!s||typeof s.validate!=='function'){console.log(JSON.stringify({skipped:true}));process.exit(0)}" +
      "const r=s.validate(process.env,{abortEarly:false,allowUnknown:true});" +
      "console.log(JSON.stringify({errors:r.error?r.error.details.map(function(d){return d.message}):[]}))";
    try {
      const { stdout } = await execFileAsync(this.config.releaseBuild.nodeBin, ['-e', script, schemaFile], { cwd: candidatePath, env: process.env, timeout: 30_000 });
      const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { skipped?: boolean; errors?: string[] };
      if (parsed.skipped) return { status: 'skipped', errors: [], detail: 'candidate schema has no validate()' };
      const errors = (parsed.errors ?? []).map((m) => m.slice(0, 200));
      return { status: errors.length > 0 ? 'invalid' : 'valid', errors };
    } catch (err) {
      return { status: 'invalid', errors: [`the candidate's configuration schema could not be evaluated: ${err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : String(err)}`] };
    }
  }

  /**
   * Layer 2 - APPLICATION STARTUP. After the restart trigger the new process must actually ANSWER. Under Passenger the first request is also what starts it, so polling
   * is both the trigger and the proof. Configured by `RELEASE_READINESS_URL` (public URL); every `RELEASE_HEALTH_ENDPOINTS` path must return 2xx before the timeout.
   * Not configured => `unverified` (the engine cannot know), never a silent "ok".
   */
  private async verifyApplicationReadiness(): Promise<{ status: 'verified' | 'unverified'; detail: Record<string, unknown> }> {
    const { readinessUrl, readinessTimeoutSeconds, healthEndpoints } = this.config.releaseDeploy;
    if (!readinessUrl) {
      this.logger.warn('RELEASE_READINESS_URL is not set: the engine cannot verify that the restarted application answers. The deploy is recorded DEPLOYED_UNVERIFIED.');
      return { status: 'unverified', detail: { reason: 'RELEASE_READINESS_URL not configured' } };
    }
    const deadline = Date.now() + readinessTimeoutSeconds * 1000;
    const results: Record<string, string> = {};
    for (const path of healthEndpoints) {
      const url = readinessUrl.replace(/\/$/, '') + path;
      let ok = false;
      let last = 'no response';
      while (!ok && Date.now() < deadline) {
        try {
          const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
          last = `HTTP ${res.status}`;
          ok = res.ok;
        } catch (err) {
          last = err instanceof Error ? err.message : String(err);
        }
        if (!ok && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2_000));
      }
      results[path] = ok ? 'ok' : last;
      if (!ok) {
        throw new PostSwapReadinessError('startup', `APPLICATION_STARTUP_FAILED: ${path} did not answer 2xx within ${readinessTimeoutSeconds}s (last: ${last}) at ${readinessUrl}`);
      }
    }
    return { status: 'verified', detail: { url: readinessUrl, endpoints: results } };
  }

  /** Is the platform `installation` row (target of `companies.installationId`) present? `null` when it cannot be read (table missing). */
  private async readInstallationPresent(): Promise<boolean | null> {
    try {
      const rows: unknown[] = await this.dataSource.query(`SELECT 1 FROM "installation" WHERE "id" = 'installation'`);
      return rows.length > 0;
    } catch {
      return null;
    }
  }

  /**
   * Layer 3 - FUNCTIONAL READINESS: the platform is initialised. Only meaningful once the new application has booted (it initialises the implicit installation at
   * boot), so it runs after a VERIFIED startup. `unlicensed-full` must have a row (the application is expected to create it). `enforced` without a licence is a
   * licensing state, not a deploy defect: a warning - unless the row EXISTED before this deploy and is gone now.
   */
  private async verifyFunctionalReadiness(installationPresentBefore: boolean | null): Promise<{ status: 'ok' | 'warning'; detail: Record<string, unknown> }> {
    const present = await this.readInstallationPresent();
    const mode = this.config.entitlement.mode;
    if (present) return { status: 'ok', detail: { installation: 'present', mode } };
    if (mode === 'unlicensed-full' || installationPresentBefore === true) {
      throw new PostSwapReadinessError(
        'initialization',
        `INITIALIZATION_FAILED: the platform installation row is missing after the deploy (mode ${mode}${installationPresentBefore ? ', it existed before' : ''}) - Companies cannot be created.`,
      );
    }
    return { status: 'warning', detail: { installation: 'absent', mode, note: 'ENTITLEMENT_MODE=enforced and no licence applied: apply a signed entitlement manifest (pre-existing state).' } };
  }

  private static classifyFailure(err: unknown, swapped: boolean): DeployOutcome {
    if (err instanceof PostSwapReadinessError) return err.kind === 'startup' ? 'APPLICATION_STARTUP_FAILED' : 'INITIALIZATION_FAILED';
    return swapped ? 'POST_DEPLOYMENT_VALIDATION_FAILED' : 'DEPLOYMENT_FAILED';
  }

  private async runSmokeGet(): Promise<string[]> {
    const { healthBaseUrl, smokeGetEndpoints } = this.config.releaseDeploy;
    const failures: string[] = [];
    for (const path of smokeGetEndpoints) {
      const url = healthBaseUrl.replace(/\/$/, '') + path;
      try {
        const res = await fetch(url, { method: 'GET' });
        if (res.status === 401 || res.status === 403) {
          failures.push(
            `${path} → HTTP ${res.status} — this endpoint requires authentication; ` +
              `RELEASE_SMOKE_GET_ENDPOINTS must list only PUBLIC GET endpoints (e.g. /api/health, /api/health/db). ` +
              `Fix the config — do not put an authenticated route here.`,
          );
        } else if (!res.ok) {
          failures.push(`${path} → HTTP ${res.status}`);
        }
      } catch (err) {
        failures.push(`${path} → ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return failures;
  }

  /**
   * Invariant I-8 support — read the NEW (not-yet-applied) migration files
   * this deploy will actually run and scan their `up()` bodies for
   * contraction DDL. Returns `[]` when nothing is pending or the pending
   * set is all expand/contract-safe. Best-effort textual scan — see
   * `expand-contract-guard.ts` for the disclosed limitation.
   *
   * MUST filter down to the true pending set, not "every migration path the
   * manifest declares" — for a `packageType: 'full'` release EVERY file is
   * declared `action: 'modify'` (a full package legitimately ships the
   * entire codebase), so a path-only filter re-scans the project's ENTIRE
   * migration history on every full-package deploy, including migrations
   * that already ran against the target DB months ago. That produced a
   * confirmed false-positive PreSwapAbort in production (correlation
   * `9e374dab-8acb-4174-94e0-728aa8075842`): old, already-applied
   * migrations flagged as if they were new contraction risk. A first fix
   * (re-deriving executed/pending by hand, mirroring what
   * `runReleaseMigrations` below used to do) still disagreed with reality
   * for two genuinely-executed migrations (correlation
   * `f3c3c8ca-bd5c-4f80-be25-679432ef518f`) — both were independently
   * confirmed present in the target DB's `migrations` table with the
   * exact expected name, so the hand-rolled computation itself was wrong,
   * not the name derivation or the data. Both this method and
   * `runReleaseMigrations` now delegate to TypeORM's own
   * `MigrationExecutor.getPendingMigrations()` instead of re-deriving it —
   * see the inline comment below.
   */
  private async scanDeltaMigrations(
    release: Release,
    candidatePath: string,
    tags?: readonly string[],
  ): Promise<ReturnType<typeof scanForContraction>> {
    const migrationFiles = release.manifest.files.filter((f) => f.action !== 'delete' && isMigrationPath(f.path));
    if (migrationFiles.length === 0) return [];

    const migrationDataSource = createMigrationDataSource(candidatePath, this.config.database, tags);
    await migrationDataSource.initialize();
    let pendingNames: Set<string>;
    try {
      // Delegate to TypeORM's OWN pending-migration computation
      // (`MigrationExecutor.getPendingMigrations()` — the exact code
      // `runMigrations()`/`showMigrations()` use) instead of re-deriving
      // executed/pending by hand. A hand-rolled duplicate of this logic
      // (`SELECT name FROM migrations` + a manual Set diff) previously
      // diverged from TypeORM's real behavior for two genuinely-executed
      // Production migrations — correlation
      // `f3c3c8ca-bd5c-4f80-be25-679432ef518f` — even after independently
      // confirming both the derived name and the stored DB row were
      // correct, so the mismatch was in the hand-rolled computation itself,
      // not in name derivation or the data. Delegating removes that whole
      // class of risk by construction: this scan can never disagree with
      // what `runReleaseMigrations` is about to actually do, because it
      // now asks the same library code the same question.
      const executor = new MigrationExecutor(migrationDataSource);
      const pending = await executor.getPendingMigrations();
      pendingNames = new Set(pending.map((m) => m.name));

      // TEMPORARY diagnostic — correlation f064242d-9bf0-461c-b63e-8dfd26312489.
      // Isolated reproduction of this exact call (same files, same DB) shows
      // 0 pending / 123 executed; the in-process call during a real deploy
      // has behaved as if nothing were executed. No behavior change — reads
      // executed migrations only for logging (the same data
      // getPendingMigrations() already computed internally); the connection
      // password is never logged. Remove once the discrepancy is found.
      //
      // Uses `.error()`, not `.warn()`, deliberately: NestJS's ConsoleLogger
      // (`node_modules/@nestjs/common/services/console-logger.service.js`)
      // only routes `error()` to `process.stderr` explicitly
      // (`printMessages(..., 'error', 'stderr')`) — every other level,
      // `warn()` included, defaults to `process.stdout`
      // (`process[writeStreamType ?? 'stdout'].write(...)`). The prior
      // build's `.warn()` line was real but written to a stdout stream this
      // CloudLinux/Passenger setup apparently never captures to any file —
      // `stderr.log` is the one proven-working destination (used earlier
      // this session to diagnose the registerRelease QueryFailedError), so
      // this line now goes there deliberately. Same single-string-argument
      // shape `this.logger.error(...)` already uses elsewhere in this file
      // (e.g. the FAILED-SAFE log line) — no stack trace expected/needed.
      const { host, port, username, database } = this.config.database;
      const executed = await executor.getExecutedMigrations();
      this.logger.error(
        `[DIAG f064242d] scanDeltaMigrations connection=${username}@${host}:${port}/${database} ` +
          `migrationsLoaded=${migrationDataSource.migrations.length} executedCount=${executed.length} ` +
          `pendingCount=${pending.length} pendingNames=${JSON.stringify(pending.map((m) => m.name))}`,
      );
    } finally {
      await migrationDataSource.destroy();
    }

    // Manifest path "<ts>-<ClassName>.(ts|js)" -> TypeORM migration name
    // "<ClassName><ts>" — the same derivation `generate_manifest`'s fallback
    // uses in build-release.sh when a migration has no explicit `name` field.
    const pendingFiles = migrationFiles.filter((f) => {
      const base = f.path.replace(/\.(ts|js)$/, '').split('/').pop() ?? '';
      const i = base.indexOf('-');
      if (i < 0) return false;
      return pendingNames.has(base.slice(i + 1) + base.slice(0, i));
    });
    if (pendingFiles.length === 0) return [];

    const sources: Array<{ path: string; source: string }> = [];
    for (const f of pendingFiles) {
      try {
        sources.push({ path: f.path, source: await readFile(join(candidatePath, f.path), 'utf8') });
      } catch {
        // a manifest migration entry with no readable file in the CANDIDATE
        // is itself a problem, but that is the package validator's job — here
        // we only scan what we can read.
      }
    }
    return scanForContraction(sources);
  }

  private async getMigrationHead(): Promise<string | null> {
    try {
      const rows: Array<{ name: string }> = await this.dataSource.query('SELECT name FROM migrations ORDER BY timestamp DESC, id DESC LIMIT 1');
      return rows[0]?.name ?? null;
    } catch {
      return null;
    }
  }

  private async writeRollbackReason(releaseId: string, rollbackReason: string, errorMessage: string | null): Promise<void> {
    const p = join(this.config.releaseDeploy.manifestsPath, `rollback-${releaseId}.json`);
    await mkdir(dirname(p), { recursive: true }).catch(() => undefined);
    await writeFile(p, JSON.stringify({ release_id: releaseId, rollback_reason: rollbackReason, error_message: errorMessage, reverted_at: new Date().toISOString() }, null, 2) + '\n').catch(() => undefined);
  }

  /** Read the rollback-reason sidecar for a release (drill vs real-failure distinction — rev-3 dep #3). Null if none. */
  async readRollbackReason(releaseId: string): Promise<{ rollback_reason: string; error_message: string | null; reverted_at: string } | null> {
    try {
      const raw = await (await import('fs/promises')).readFile(join(this.config.releaseDeploy.manifestsPath, `rollback-${releaseId}.json`), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private async snapshotBeforeDeploy(release: Release, appRoot: string): Promise<void> {
    const snapshotDir = this.snapshotDirFor(release.id);
    for (const file of release.manifest.files) {
      if (file.action === 'add') continue; // rollback of an 'add' is just deleting it — nothing to snapshot.
      const liveAbsolutePath = this.resolveAppDestination(appRoot, file.path);
      const exists = await stat(liveAbsolutePath)
        .then(() => true)
        .catch(() => false);
      if (!exists) continue; // nothing live to protect yet — deploy will create/skip as appropriate.
      const snapshotPath = join(snapshotDir, file.path);
      await mkdir(dirname(snapshotPath), { recursive: true });
      await copyFile(liveAbsolutePath, snapshotPath);
    }
  }

  private async deployFiles(release: Release, stagingDir: string, appRoot: string): Promise<void> {
    for (const file of release.manifest.files) {
      const destPath = this.resolveAppDestination(appRoot, file.path);
      if (file.action === 'delete') {
        await rm(destPath, { force: true });
        continue;
      }
      const sourcePath = join(stagingDir, file.path);
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(sourcePath, destPath);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // ERP Foundation P6 (T2) — Edition entitlement + Module lifecycle, added
  // at the deploy pipeline's existing seams (ADR-023 Part D — extend, never
  // refactor Gen-2 internals). All of this is a no-op unless the release's
  // manifest carries an `entitlement` section.
  // ─────────────────────────────────────────────────────────────────────

  /** Tag set for the migration glob — Core + entitled modules + closure. */
  private async resolveEntitlementTags(appRoot: string): Promise<string[]> {
    const ent = this.config.entitlement;
    return readEnabledModules({
      appRoot,
      dataSource: this.dataSource,
      publicKeys: ent?.publicKeys ?? [],
      mode: ent?.mode ?? 'unlicensed-full',
      clockToleranceMinutes: ent?.clockToleranceMinutes,
      logger: (m) => this.logger.warn(`[entitlement] ${m}`),
    });
  }

  private entitlementFilePath(): string {
    return join(this.config.releaseExecution.appRoot, 'entitlement.manifest.json');
  }

  /**
   * PRE-SWAP: verify the release's signed entitlement manifest and write it to
   * `<appRoot>/entitlement.manifest.json` (+ `.sig`) so `readEnabledModules`
   * — and therefore the migration glob — sees the new module set BEFORE
   * migrations run (ADR-025 §4.2). A bad signature aborts the deploy with
   * ACTIVE bit-for-bit untouched (I-2). Returns the previous manifest text
   * for rollback, plus the verified manifest + signature for the post-swap
   * step, or `null` when the release carries no entitlement.
   */
  private async applyEntitlementManifestPreSwap(
    release: Release,
    candidatePath: string,
    actorUserId: string,
  ): Promise<{ manifest: EntitlementManifest; signatureB64: string; prevText: string | null } | null> {
    const ent = release.manifest.entitlement;
    if (!ent) return null;

    const manifestSrc = join(candidatePath, ent.manifestPath);
    let rawJson: string;
    try {
      rawJson = await readFile(manifestSrc, 'utf8');
    } catch {
      throw new PreSwapAbort(`entitlement: manifest file "${ent.manifestPath}" not found in the package`);
    }
    // signature is ALWAYS detached (a sibling `.sig`, or an explicit
    // `signaturePath`) — the signed bytes are the canonical manifest itself.
    const sigPath = ent.signaturePath ?? `${ent.manifestPath}.sig`;
    let signatureB64: string;
    try {
      signatureB64 = (await readFile(join(candidatePath, sigPath), 'utf8')).trim();
    } catch {
      throw new PreSwapAbort(`entitlement: signature file "${sigPath}" not found in the package`);
    }

    const cfg = this.config.entitlement;
    const result = verifyManifest(rawJson, signatureB64, {
      publicKeys: cfg?.publicKeys ?? [],
      clockToleranceMinutes: cfg?.clockToleranceMinutes,
      currentFingerprint: computeInstallationFingerprint(),
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

    // cross-check the release-manifest summary against the signed truth
    const declared = new Set(ent.moduleCodes);
    const signed = new Set(result.manifest.module_codes);
    if (ent.moduleCodes.length && (declared.size !== signed.size || [...declared].some((c) => !signed.has(c)))) {
      throw new PreSwapAbort(
        `entitlement: release manifest moduleCodes [${[...declared].join(', ')}] disagree with the signed manifest [${[...signed].join(', ')}]`,
      );
    }

    const target = this.entitlementFilePath();
    const prevText = existsSync(target) ? await readFile(target, 'utf8') : null;
    // canonical form on disk so a later read verifies byte-identically
    await writeFile(target, canonicalize(result.manifest), 'utf8');
    await writeFile(`${target}.sig`, signatureB64, 'utf8');

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

  /** POST-SWAP (after health + smoke): write the `installation` row and seed every newly-entitled module. A failure here is a normal post-swap failure → I-3 rollback. */
  private async enableModulesPostSwap(
    applied: { manifest: EntitlementManifest; signatureB64: string },
    actorUserId: string,
  ): Promise<void> {
    if (!this.moduleLifecycle) {
      this.logger.warn('entitlement: ModuleLifecycleService not available — installation row + module seeding skipped');
      return;
    }
    const r = await this.moduleLifecycle.applyEntitlementAndEnableModules(applied.manifest, applied.signatureB64, actorUserId);
    this.logger.log(
      `entitlement applied: edition ${applied.manifest.edition_code} v${applied.manifest.edition_version}` +
        (r.modulesAdded.length ? `, enabled module(s): ${r.modulesAdded.join(', ')}` : ', no new modules'),
    );
  }

  /** Rollback: put `entitlement.manifest.json` back to its pre-deploy content (or remove it if there was none). */
  private async restoreEntitlementManifest(prevText: string | null): Promise<void> {
    const target = this.entitlementFilePath();
    try {
      if (prevText === null) {
        await rm(target, { force: true });
        await rm(`${target}.sig`, { force: true });
      } else {
        await writeFile(target, prevText, 'utf8');
      }
    } catch (e) {
      this.logger.error(`entitlement: failed to restore ${target} on rollback: ${(e as Error).message}`);
    }
  }

  private async runReleaseMigrations(release: Release, appRoot: string, tags?: readonly string[]): Promise<void> {
    const migrationDataSource = createMigrationDataSource(appRoot, this.config.database, tags);
    const migrationRunRepo = this.dataSource.getRepository(ReleaseMigrationRun);
    const startedAt = new Date();

    await migrationDataSource.initialize();
    let pendingNames: string[] = [];
    try {
      // Same delegation as `scanDeltaMigrations` above (correlation
      // `f3c3c8ca-bd5c-4f80-be25-679432ef518f`) — ask TypeORM's own
      // `MigrationExecutor.getPendingMigrations()` rather than
      // re-deriving executed/pending by hand, so this audit list can
      // never disagree with what `runMigrations()` itself is about to do.
      const pending = await new MigrationExecutor(migrationDataSource).getPendingMigrations();
      pendingNames = pending.map((m) => m.name);

      await migrationDataSource.runMigrations();

      for (const name of pendingNames) {
        await migrationRunRepo.save(
          migrationRunRepo.create({
            releaseId: release.id,
            migrationName: name,
            startedAt,
            completedAt: new Date(),
            success: true,
            errorMessage: null,
          }),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Default TypeORM migrationsTransactionMode is "all" (one
      // transaction for the whole pending batch) — a thrown error here
      // means Postgres already rolled back the ENTIRE batch, so none of
      // `pendingNames` actually committed. Logged as failed for
      // traceability, not because we know which single one syntactically
      // threw, but because we know none of them ended up applied.
      for (const name of pendingNames) {
        await migrationRunRepo.save(
          migrationRunRepo.create({
            releaseId: release.id,
            migrationName: name,
            startedAt,
            completedAt: new Date(),
            success: false,
            errorMessage: message,
          }),
        );
      }
      throw err;
    } finally {
      await migrationDataSource.destroy();
    }
  }

  /**
   * Post-condition for Invariant I-8b (Production Incident 2026-09-22):
   * `runReleaseMigrations()` completing without throwing is NOT sufficient
   * proof that this release's own migrations actually ran — it only proves
   * `runMigrations()` didn't throw against whatever `pendingNames` it
   * computed at that moment. If the migration DataSource's scope excludes
   * a tag this release's manifest ships migrations under (the proven cause
   * of the four `SeedAdminPermissionsFor*` migrations from v1.1.1 never
   * reaching the `migrations` table), `runMigrations()` succeeds having
   * done nothing for those files, silently.
   *
   * This re-opens a FRESH `MigrationExecutor` (same delegation discipline
   * as `scanDeltaMigrations`/`runReleaseMigrations` — never a hand-rolled
   * diff) against the exact same candidatePath + tags, and cross-checks
   * every migration file THIS RELEASE'S OWN MANIFEST declares against
   * what is now still pending. Returns the migration names that are still
   * pending — non-empty means the migration phase did not actually
   * complete for this release, regardless of what `runMigrations()`
   * reported.
   */
  private async verifyMigrationsComplete(release: Release, candidatePath: string, tags?: readonly string[]): Promise<string[]> {
    // Same manifest-path -> TypeORM-name derivation `scanDeltaMigrations` and
    // `migration-preflight.ts`'s `migrationNameFromFilePath` already use:
    // "<timestamp>-<ClassName>.(ts|js)" -> "<ClassName><timestamp>".
    const shippedMigrationNames = new Set<string>();
    for (const f of release.manifest.files) {
      if (f.action === 'delete' || !isMigrationPath(f.path) || f.path.endsWith('.d.ts')) continue;
      const base = f.path.replace(/\.(ts|js)$/, '').split('/').pop() ?? '';
      const i = base.indexOf('-');
      if (i < 0) continue;
      shippedMigrationNames.add(base.slice(i + 1) + base.slice(0, i));
    }
    if (shippedMigrationNames.size === 0) return [];

    const migrationDataSource = createMigrationDataSource(candidatePath, this.config.database, tags);
    await migrationDataSource.initialize();
    try {
      const pending = await new MigrationExecutor(migrationDataSource).getPendingMigrations();
      const pendingNames = new Set(pending.map((m) => m.name));
      return [...shippedMigrationNames].filter((name) => pendingNames.has(name));
    } finally {
      await migrationDataSource.destroy();
    }
  }

  /**
   * Manual rollback trigger (also called automatically by `deployRelease`
   * on any failure). Order matters: migrations are undone FIRST, while the
   * newly-deployed migration files are still on disk (their `down()`
   * bodies must be loadable), THEN files are restored/removed. If
   * migration-undo itself fails partway, the loop stops immediately and
   * falls back to a full database restore from the SAME verified backup
   * this release was gated on — the documented "last resort" from
   * ADR-020 §6 — rather than continuing to guess.
   */
  async rollbackRelease(releaseId: string, actorUserId: string): Promise<Release> {
    const releaseRepo = this.dataSource.getRepository(Release);
    const release = await releaseRepo.findOne({ where: { id: releaseId } });
    if (!release) throw new NotFoundException(`Release "${releaseId}" not found.`);

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
    const migrationRunRepo = this.dataSource.getRepository(ReleaseMigrationRun);
    const successfulRuns = await migrationRunRepo.find({ where: { releaseId, success: true }, order: { startedAt: 'DESC', id: 'DESC' } });

    let migrationUndoFailed = false;
    if (successfulRuns.length > 0) {
      const migrationDataSource = createMigrationDataSource(appRoot, this.config.database);
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
      } catch (err) {
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
      } finally {
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
    } catch (err) {
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

  private async fallbackFullRestore(release: Release, actorUserId: string): Promise<boolean> {
    if (!release.backupRunId) return false;
    try {
      const preflight = await this.restoreManager.preflight(release.backupRunId, actorUserId);
      if (preflight.status !== 'pending_confirmation') {
        return false;
      }
      await this.restoreManager.confirmAndRestore(preflight.id, actorUserId);
      return true;
    } catch (err) {
      this.logger.error(`Fallback full restore failed for release "${release.id}"`, err instanceof Error ? err.stack : String(err));
      return false;
    }
  }

  /**
   * Passenger reloads the app when its restart file's mtime changes
   * (v1.0.3 report item 17 — the manual deploy had to `touch
   * release-new/backend/tmp/restart.txt` by hand). Creates the file (and
   * its `tmp/` dir) if missing, otherwise bumps its mtime. A failure here
   * is logged + audited but NEVER fails the deploy/rollback — the files
   * and migrations are already applied; a missed auto-restart is an
   * operator "click Restart in cPanel" follow-up, not a reason to roll back
   * a good deploy.
   */
  private async triggerPassengerRestart(releaseId: string, actorUserId: string, phase: 'deploy' | 'rollback'): Promise<void> {
    const restartFile = this.config.releaseExecution.passengerRestartFile;
    try {
      await mkdir(dirname(restartFile), { recursive: true });
      const exists = await stat(restartFile)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        const now = new Date();
        await utimes(restartFile, now, now);
      } else {
        await writeFile(restartFile, `restart requested by release ${releaseId} (${phase}) at ${new Date().toISOString()}\n`);
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
    } catch (err) {
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

  private async restoreFilesFromSnapshot(release: Release, appRoot: string): Promise<void> {
    const snapshotDir = this.snapshotDirFor(release.id);
    for (const file of release.manifest.files) {
      const liveAbsolutePath = this.resolveAppDestination(appRoot, file.path);
      if (file.action === 'add') {
        await rm(liveAbsolutePath, { force: true });
        continue;
      }
      const snapshotPath = join(snapshotDir, file.path);
      const snapshotExists = await stat(snapshotPath)
        .then(() => true)
        .catch(() => false);
      if (snapshotExists) {
        await mkdir(dirname(liveAbsolutePath), { recursive: true });
        await copyFile(snapshotPath, liveAbsolutePath);
      } else {
        // No prior snapshot means the file didn't exist before this
        // release touched it (a 'modify'/'delete' entry against a file
        // that, in fact, wasn't there) — best-effort: remove whatever the
        // deploy step left behind so the app root doesn't retain it.
        await rm(liveAbsolutePath, { force: true });
      }
    }
  }
}
