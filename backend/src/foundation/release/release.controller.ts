import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { IsIn, IsObject, IsUUID } from 'class-validator';
import { DataRepairService } from './data-repair.service';
import { DataRepairRun } from './data-repair-run.entity';
import { DataRepairKind } from './data-repair-status';
import { DeployPreflightService } from './deploy-preflight.service';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { rm } from 'fs/promises';
import { BackupManagerService } from './backup-manager.service';
import { RestoreManagerService } from './restore-manager.service';
import { ReleaseManagerService } from './release-manager.service';
import { ReleaseExecutionService } from './release-execution.service';
import { BackupRun } from './backup-run.entity';
import { BackupArtifact } from './backup-artifact.entity';
import { RestoreOperation } from './restore-operation.entity';
import { Release } from './release.entity';
import { ReleaseMigrationRun } from './release-migration-run.entity';
import { ReleaseManifest } from './release-manifest';
import { ReleasePackageType } from './release-status';
import { readAppVersion } from './app-version';
import { readBuildInfo } from './build-info';
import { AppConfigService } from '../configuration/app-config.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { RolesGuard } from '../authorization/roles.guard';
import { RequireRole } from '../authorization/require-role.decorator';
import { PermissionGuard } from '../permission/permission.guard';
import { RequirePermission } from '../permission/require-permission.decorator';

/**
 * The manifest's own internal shape (`ReleaseManifest.files[]`
 * checksums, migrations, etc.) is validated by
 * `ReleaseManagerService.validateManifest` — the actual business rule
 * (CTO directive §9/§10), not re-implemented here as nested
 * class-validator decorators. This DTO only checks the envelope fields
 * a controller genuinely owns: which endpoint/permission applies
 * (`packageType`) and that a manifest object was sent at all.
 */
class RegisterReleaseDto {
  @IsIn(['full', 'delta'])
  packageType!: ReleasePackageType;

  @IsObject()
  manifest!: ReleaseManifest;
}

class LinkBackupDto {
  @IsUUID()
  backupRunId!: string;
}

class CreateDataRepairDto {
  @IsIn(['uuid_rfc4122'])
  kind!: DataRepairKind;
}

/**
 * Backup Gate Fix (2026-08-31): backup/artifact `errorMessage` values now
 * carry the full `pg_dump`/`pg_restore` diagnostic (binary path, stderr) so
 * an operator can act on it — that detail belongs in the DB row, the audit
 * trail, the server log, and the on-disk backup manifest, but NOT verbatim
 * in an HTTP response: absolute filesystem paths + raw tool stderr in a
 * response body are an information-disclosure smell AND can trip an
 * OUTBOUND LiteSpeed/ModSecurity rule (403). This redacts responses only —
 * the stored value is untouched. `GET`ing the on-disk
 * `<backup-storage>/manifests/<runId>.json` gives the operator the full,
 * unredacted detail via a non-HTTP channel.
 */
function redactErrorForResponse<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(/(?:[A-Za-z]:)?(?:\/[\w.@+-]+){2,}/g, '<path>')
      .replace(/\s+/g, ' ')
      .slice(0, 400) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(redactErrorForResponse) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === 'errorMessage' || k === 'error' ? redactErrorForResponse(v) : v;
    }
    return out as T;
  }
  return value;
}

/**
 * Release Center — Phases A (Backup) + B (Restore). Two guard layers:
 *
 * - `RolesGuard`/`@RequireRole('admin')` at the class level — the proven,
 *   everywhere-used coarse gate (same pattern as `AdminController`).
 *   Nobody who isn't already an admin reaches ANY route here.
 * - `PermissionGuard`/`@RequirePermission` per-route — the Permission
 *   Engine's first real production use. Read endpoints check
 *   `system.release.view`; write/action endpoints check the specific
 *   action node (`system.release.backup`, `system.release.restore`, and
 *   `system.release.deploy`/`system.release.rollback` once Phase C adds
 *   them) — the exact node names the CTO directive specified. The
 *   Permission Engine has NO admin auto-bypass (confirmed by reading
 *   `permission.service.ts` directly) — the `AddReleaseBackupTables`
 *   migration grants `admin` 'editable' at the PARENT `system.release`
 *   node, which covers every current and future child node
 *   (`system.release.*`) via the engine's own ancestor-chain walk, with
 *   zero further migration needed as new leaf nodes are added.
 */
@Controller('release')
@UseGuards(JwtAuthGuard, RolesGuard)
@RequireRole('admin')
export class ReleaseController {
  constructor(
    private readonly backupManager: BackupManagerService,
    private readonly restoreManager: RestoreManagerService,
    private readonly releaseManager: ReleaseManagerService,
    private readonly releaseExecution: ReleaseExecutionService,
    private readonly dataRepair: DataRepairService,
    private readonly deployPreflight: DeployPreflightService,
    private readonly config: AppConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.view', 'read-only')
  @Get('backups')
  async listBackups() {
    return redactErrorForResponse(await this.dataSource.getRepository(BackupRun).find({ order: { startedAt: 'DESC' }, take: 100 }));
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.view', 'read-only')
  @Get('backups/:id')
  async getBackup(@Param('id') id: string) {
    const run = await this.dataSource.getRepository(BackupRun).findOne({ where: { id } });
    const artifacts = await this.dataSource.getRepository(BackupArtifact).find({ where: { backupRunId: id } });
    return redactErrorForResponse({ run, artifacts });
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.backup', 'editable')
  @Post('backups')
  async createBackup(@Req() req: AuthenticatedRequest) {
    return redactErrorForResponse(await this.backupManager.createBackup('manual', req.user.id));
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.backup', 'editable')
  @Post('backups/artifacts/:artifactId/verify')
  async reverifyBackupArtifact(@Param('artifactId') artifactId: string) {
    return redactErrorForResponse(await this.backupManager.reverifyArtifact(artifactId));
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.view', 'read-only')
  @Get('restores/:id')
  async getRestore(@Param('id') id: string) {
    return this.dataSource.getRepository(RestoreOperation).findOne({ where: { id } });
  }

  /** Step 1 of 2 — read-only, never touches the database. Returns a `RestoreOperation` a human must review before calling `confirm` below. */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.restore', 'editable')
  @Post('backups/:backupRunId/restore/preflight')
  async preflightRestore(@Param('backupRunId') backupRunId: string, @Req() req: AuthenticatedRequest) {
    return this.restoreManager.preflight(backupRunId, req.user.id);
  }

  /** Step 2 of 2 — the only endpoint in this codebase that actually overwrites live database content. Requires a `pending_confirmation` operation from `preflight` above, within its confirmation window. */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.restore', 'editable')
  @Post('restores/:id/confirm')
  async confirmRestore(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.restoreManager.confirmAndRestore(id, req.user.id);
  }

  // --- Backup/DR Architecture V1 (2026-09-24, Track D §Step 10, D-Backup-05/06).
  // The Installation-Admin half of the dual authorization path: a platform
  // admin explicitly names a Company via the route param (unlike the
  // self-service `CompanyBackupController`, which derives it exclusively
  // from `req.companyContext` — never a client-suppliable identifier
  // there). This controller's own class-level `RolesGuard`/`@RequireRole('admin')`
  // is what makes trusting the route param here legitimate: only a
  // platform admin reaches these handlers at all, exactly the same
  // precedent `InstallationMembershipController` already established for
  // Membership HTTP Management's own D2 dual path. `companyId` is still
  // only ever an INPUT to `DatabaseRegistryService`'s validated chain
  // inside `BackupManagerService`/`RestoreManagerService` — never a direct
  // database selector reaching those services from here.

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.view', 'read-only')
  @Get('companies/:companyId/backups')
  async listCompanyBackups(@Param('companyId') companyId: string) {
    return redactErrorForResponse(
      await this.dataSource.getRepository(BackupRun).find({ where: { companyId }, order: { startedAt: 'DESC' }, take: 100 }),
    );
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.backup', 'editable')
  @Post('companies/:companyId/backups')
  async createCompanyBackup(@Param('companyId') companyId: string, @Req() req: AuthenticatedRequest) {
    return redactErrorForResponse(await this.backupManager.createBackup('manual', req.user.id, companyId));
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.restore', 'editable')
  @Post('companies/:companyId/backups/:backupRunId/restore/preflight')
  async preflightCompanyRestore(@Param('companyId') companyId: string, @Param('backupRunId') backupRunId: string, @Req() req: AuthenticatedRequest) {
    return this.restoreManager.preflight(backupRunId, req.user.id, companyId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.restore', 'editable')
  @Post('companies/:companyId/restores/:id/confirm')
  async confirmCompanyRestore(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    // `companyId` is re-validated INSIDE confirmAndRestore/preflight against the RestoreOperation's
    // own stored companyId (fixed at preflight time) — the route param here is for URL clarity only,
    // it is never trusted as the source of truth for which Company is actually being restored.
    return this.restoreManager.confirmAndRestore(id, req.user.id);
  }

  // --- Phase C (foundation slice): register/validate a release manifest,
  // link it to a verified backup, and check the mandatory deployment
  // gate. Actual file deployment/migration execution/health-check/
  // rollback endpoints are the next increment — see
  // `ReleaseManagerService`'s doc comment for the explicit scope boundary.

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.view', 'read-only')
  @Get('releases')
  async listReleases() {
    return this.dataSource.getRepository(Release).find({ order: { uploadedAt: 'DESC' }, take: 100 });
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.view', 'read-only')
  @Get('releases/:id')
  async getRelease(@Param('id') id: string) {
    return this.dataSource.getRepository(Release).findOne({ where: { id } });
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.deploy', 'editable')
  @Post('releases')
  async registerRelease(@Body() dto: RegisterReleaseDto, @Req() req: AuthenticatedRequest) {
    return this.releaseManager.registerRelease(dto.manifest, dto.packageType, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.deploy', 'editable')
  @Post('releases/:id/link-backup')
  async linkReleaseBackup(@Param('id') id: string, @Body() dto: LinkBackupDto, @Req() req: AuthenticatedRequest) {
    return this.releaseManager.linkVerifiedBackup(id, dto.backupRunId, req.user.id);
  }

  /** Read-only check — "would a deploy be allowed right now." Never itself deploys anything. */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.deploy', 'read-only')
  @Get('releases/:id/deployment-gate')
  async checkDeploymentGate(@Param('id') id: string) {
    return this.releaseManager.checkDeploymentGate(id);
  }

  /**
   * Upgrade Resolver (Release Engine overhaul, stage 3/4 — CTO Directive,
   * Production Incident 2026-09-15 post-mortem). Read-only planning
   * question, distinct from `deployment-gate`: "can the currently installed
   * version reach THIS release at all, and through which intermediate
   * releases?" — never itself deploys anything, and never duplicates the
   * Migration Preflight's own per-release compatibility gate that runs at
   * actual deploy time.
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.deploy', 'read-only')
  @Get('releases/:id/upgrade-path')
  async resolveUpgradePath(@Param('id') id: string) {
    return this.releaseManager.resolveUpgradePath(id);
  }

  /** Read-only host/environment readiness (binaries, disk, DB, paths). Run before a deploy; the deploy runs it again itself (with the staged package) and STOPs on any critical fail. */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.deploy', 'read-only')
  @Get('preflight')
  async deployPreflightCheck() {
    return this.deployPreflight.runPreflight();
  }

  // --- Execution Layer: real ZIP upload/staging, deploy, rollback, and
  // per-migration traceability. See `ReleaseExecutionService` doc comment
  // for the full pipeline and the migration-DataSource technical note.

  /**
   * The current installed application version + build tag — for the UI's
   * header and for `DLT-TEST-001` (the pipeline proof observes `buildTag`
   * flip on deploy and revert to `null` on the deliberate rollback).
   * `buildTag` reads an optional `<appRoot>/dist/build-info.json`; absent →
   * `null` (never throws). `RELEASE_ENGINES_SPEC.md` rev-3 dependency #1.
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.view', 'read-only')
  @Get('version')
  getVersion() {
    return { version: readAppVersion(), buildTag: readBuildInfo(this.config.releaseExecution.appRoot).buildTag };
  }

  /** The real ZIP-upload entry point — validates, stages, and registers the release in one call. `registerRelease` (JSON-only, above) stays for tooling/tests that don't need a real zip. */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.deploy', 'editable')
  @Post('releases/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: tmpdir(), filename: (_req, _file, cb) => cb(null, `release-upload-${randomUUID()}.zip`) }),
      limits: { fileSize: 200 * 1024 * 1024 },
    }),
  )
  async uploadRelease(@UploadedFile() file: Express.Multer.File, @Body('packageType') packageType: string, @Req() req: AuthenticatedRequest) {
    if (!file) throw new BadRequestException('No file uploaded — expected a multipart "file" field containing the release ZIP.');
    if (packageType !== 'full' && packageType !== 'delta') {
      await rm(file.path, { force: true });
      throw new BadRequestException('packageType must be "full" or "delta".');
    }
    try {
      return await this.releaseExecution.uploadPackage(file.path, packageType, req.user.id);
    } finally {
      await rm(file.path, { force: true });
    }
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.deploy', 'editable')
  @Post('releases/:id/deploy')
  async deployRelease(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.releaseExecution.deployRelease(id, req.user.id);
  }

  /**
   * Explicit operator-initiated rollback. When staged activation is on
   * (CTO-P3), routes through the Release-Slots reverse-rename + LKG "pop".
   * Pass `{ "drill": "<name>" }` for a deliberate DLT-TEST-001-style drill —
   * the release row still becomes `rolled_back` (the state machine is
   * genuinely exercised) but `error_message` stays null and the
   * rollback-reason sidecar records `drill:<name>` (rev-3 dependency #3).
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.rollback', 'editable')
  @Post('releases/:id/rollback')
  async rollbackRelease(@Param('id') id: string, @Body('drill') drill: string | undefined, @Req() req: AuthenticatedRequest) {
    if (this.config.releaseDeploy.stagedActivation) {
      return this.releaseExecution.rollbackReleaseStaged(id, req.user.id, drill ? { drillName: drill } : {});
    }
    return this.releaseExecution.rollbackRelease(id, req.user.id);
  }

  /** The rollback-reason sidecar for a release — drill vs real-failure distinction (rev-3 dependency #3). */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.view', 'read-only')
  @Get('releases/:id/rollback-reason')
  async getReleaseRollbackReason(@Param('id') id: string) {
    return (await this.releaseExecution.readRollbackReason(id)) ?? { rollback_reason: null };
  }

  /**
   * Production Incident 2026-09-22 — `registerRelease()`'s own REPLACEABLE
   * re-upload policy (see its doc comment) deliberately reuses the SAME
   * release id across every re-upload of a given version, and never
   * deletes prior `release_migration_runs` rows — both correct, intentional
   * design for audit-trail preservation. But this endpoint used to return
   * ALL of them, unfiltered, for the id: after a corrected artifact was
   * re-uploaded for the same version, an operator viewing "migrations"
   * would still see the PRIOR (superseded) attempt's failures with no way
   * to tell they were stale. Every row written by one `runReleaseMigrations()`
   * call shares the exact same `startedAt` (set once, reused for the whole
   * batch — success and failure paths alike, see release-execution.service.ts)
   * — that shared timestamp IS the attempt boundary, with no schema change
   * needed to express it. Scope to `MAX(startedAt)` for this release id:
   * older attempts stay in the table (nothing deleted), this endpoint just
   * stops conflating them with the latest one.
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.view', 'read-only')
  @Get('releases/:id/migrations')
  async getReleaseMigrations(@Param('id') id: string) {
    const repo = this.dataSource.getRepository(ReleaseMigrationRun);
    const latest = await repo.createQueryBuilder('r').where('r.releaseId = :id', { id }).select('MAX(r.startedAt)', 'max').getRawOne<{ max: Date | null }>();
    if (!latest?.max) return [];
    return repo.find({ where: { releaseId: id, startedAt: latest.max }, order: { migrationName: 'ASC' } });
  }

  // --- Controlled Data Repair: audit -> plan mapping -> link verified
  // backup -> execute (one transaction) -> verify integrity. Reuses the
  // `system.release.restore` permission node for mutations (destructive,
  // backup-gated, same risk class as a restore) and `system.release.view`
  // for reads. See `DataRepairService` for the full flow and why it is a
  // first-class capability rather than a runbook.

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.view', 'read-only')
  @Get('data-repairs')
  async listDataRepairs() {
    return this.dataRepair.list();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.view', 'read-only')
  @Get('data-repairs/:id')
  async getDataRepair(@Param('id') id: string): Promise<DataRepairRun> {
    return this.dataRepair.get(id);
  }

  /** Step 1 — create the run and capture the read-only UUID audit. Nothing in any business table changes. */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.restore', 'editable')
  @Post('data-repairs')
  async createDataRepair(@Body() dto: CreateDataRepairDto, @Req() req: AuthenticatedRequest) {
    return this.dataRepair.createAndAudit(dto.kind, req.user.id);
  }

  /** Step 2 — generate the reviewable old→new id mapping (read-only). */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.restore', 'editable')
  @Post('data-repairs/:id/plan')
  async planDataRepair(@Param('id') id: string) {
    return this.dataRepair.plan(id);
  }

  /** Step 3 — tie a VERIFIED pre-repair backup to this repair (the gate). */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.restore', 'editable')
  @Post('data-repairs/:id/link-backup')
  async linkDataRepairBackup(@Param('id') id: string, @Body() dto: LinkBackupDto, @Req() req: AuthenticatedRequest) {
    return this.dataRepair.linkVerifiedBackup(id, dto.backupRunId, req.user.id);
  }

  /** Step 4 — run the repair in one transaction, then verify integrity. Only a "backup_linked" repair can be executed. */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.restore', 'editable')
  @Post('data-repairs/:id/execute')
  async executeDataRepair(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.dataRepair.execute(id, req.user.id);
  }

  /** Read-only — re-run integrity verification against the current DB state (e.g. after a restore). Does not mutate the stored run. */
  @UseGuards(PermissionGuard)
  @RequirePermission('system.release.view', 'read-only')
  @Get('data-repairs/verify/now')
  async verifyDataRepairNow() {
    return this.dataRepair.verifyNow();
  }
}
