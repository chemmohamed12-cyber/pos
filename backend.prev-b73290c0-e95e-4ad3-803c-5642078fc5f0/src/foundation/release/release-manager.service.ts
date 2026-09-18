import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { Release } from './release.entity';
import { BackupArtifact } from './backup-artifact.entity';
import { ReleaseManifest } from './release-manifest';
import { ReleasePackageType, ReleaseStatus } from './release-status';
import { computeStringChecksum } from './checksum';
import { validateManifest } from './manifest-validation';
import { AuditService } from '../audit/audit.service';

/**
 * `registerRelease` supersession policy for an existing `releases` row at
 * the SAME `version` (`IDX_releases_version` — `1755853000000-
 * AddReleasesTable.ts` — is a total UNIQUE index and stays exactly that;
 * this policy is the application-layer logic that must exist in front of
 * it, not a replacement for it). Confirmed incident, correlation
 * `db907ffa-342f-43af-a122-050fbc95b6ad`: a plain `INSERT` on every upload
 * crashed with a raw `QueryFailedError` (500) the moment a version was
 * re-uploaded — including the ordinary, expected case of retrying a
 * version whose only prior attempt never went live.
 *
 * - REPLACEABLE: the prior attempt never became the live release and
 *   nothing external (a linked backup gate, a deploy) is in flight for it
 *   — safe to supersede in place (UPDATE the same row: new manifest, reset
 *   status/backup link/error, SAME id). Reusing the id keeps
 *   `release_migration_runs` history intact (some of these statuses, e.g.
 *   a staged `'rolled_back'` after migrations already ran and were kept —
 *   I-8 expand-only — legitimately DO have migration-run rows; nothing is
 *   deleted, so there is never an FK conflict).
 * - IN_FLIGHT: a gate has been passed or a deploy is actively running —
 *   never silently overwritten; the operator must resolve it explicitly.
 * - LIVE: this version is the currently-deployed release — refuse; a new
 *   release needs a new version, not a re-upload of the same one.
 * - ALARM: FAILED-SAFE (I-4) — the application root may be in an
 *   indeterminate state; refuses to auto-anything, requires manual
 *   operator filesystem verification first.
 */
const REPLACEABLE_ON_REUPLOAD: ReadonlySet<ReleaseStatus> = new Set(['validation_failed', 'validated', 'failed', 'rolled_back']);
const LIVE_STATUS: ReleaseStatus = 'succeeded';
const ALARM_STATUS: ReleaseStatus = 'failed_safe';
// Everything else ('registered', 'backup_verified', 'deploying', 'migrating',
// 'health_checking', and any future status this policy hasn't been taught
// about yet) is treated as IN_FLIGHT — refuse rather than guess.

function isPgUniqueViolation(err: unknown, constraint: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driverErr = (err as QueryFailedError & { driverError?: { code?: string; constraint?: string } }).driverError;
  return driverErr?.code === '23505' && driverErr?.constraint === constraint;
}

/**
 * Release Center — Phase C, FOUNDATION SLICE ONLY. This service covers:
 * registering a release + validating its manifest (structure, checksums
 * present, delta base-version compatibility), linking it to a specific
 * VERIFIED backup, and enforcing the CTO directive's central rule ("No
 * Verified Backup -> No Deployment") via `checkDeploymentGate`.
 *
 * DELIBERATELY NOT in this slice: actually applying a release's files,
 * running its migrations, health-checking the result, or rolling it
 * back. Those are genuinely new, security-critical engineering surface
 * (safe zip extraction, path-traversal prevention, "never execute
 * arbitrary uploaded scripts", live migration execution against
 * production) that this pass deliberately does not rush — see the
 * Release Center Completion Report for the explicit scope boundary and
 * why. Every method here is either read-only or additive/validating; none
 * of them touch a live filesystem deployment path or run a migration.
 */
@Injectable()
export class ReleaseManagerService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Registers a release and validates its manifest — never trusts it
   * just because it was uploaded ("A Delta package is NOT trusted simply
   * because a user uploaded it"). A `'full'` package's manifest doesn't
   * need `baseVersion`; a `'delta'` package's does, and it's checked
   * against the currently installed version (`readAppVersion()`) — a
   * mismatch is recorded as `'validation_failed'`, never silently
   * accepted, per CTO directive §9's explicit "REJECT UPDATE" rule.
   *
   * Idempotent / retry-safe on `version` (see the module doc comment above
   * for the full policy — correlation `db907ffa-342f-43af-a122-050fbc95b6ad`):
   * reads for an existing row at this version FIRST and either supersedes
   * it in place (REPLACEABLE), refuses with a specific reason (IN_FLIGHT /
   * LIVE / ALARM), or inserts fresh — `IDX_releases_version` itself is
   * untouched, still a total UNIQUE index; this is the application logic
   * that belongs in front of it. A genuine race (two concurrent uploads of
   * the same brand-new version both passing the initial read) is still
   * caught at the `INSERT` and converted to the same `ConflictException`
   * rather than a raw 500.
   */
  async registerRelease(manifest: ReleaseManifest, packageType: ReleasePackageType, uploadedByUserId: string): Promise<Release> {
    const repo = this.dataSource.getRepository(Release);
    const errors = validateManifest(manifest, packageType);
    const manifestChecksum = computeStringChecksum(JSON.stringify(manifest));
    const newStatus: ReleaseStatus = errors.length === 0 ? 'validated' : 'validation_failed';

    const existing = await repo.findOne({ where: { version: manifest.version } });

    if (existing) {
      if (existing.status === LIVE_STATUS) {
        throw new ConflictException(
          `Version "${manifest.version}" is already deployed and live (release ${existing.id}, succeeded at ${existing.completedAt?.toISOString() ?? 'unknown time'}). ` +
            'Re-uploading the same version is refused — bump the version for a new release.',
        );
      }
      if (existing.status === ALARM_STATUS) {
        throw new ConflictException(
          `Release ${existing.id} for version "${manifest.version}" is in FAILED-SAFE — the last rollback for this version did not complete cleanly and the application root may be in an indeterminate state. ` +
            'This requires manual operator verification of the filesystem before any new release for this version can be registered. Not auto-replaced.',
        );
      }
      if (!REPLACEABLE_ON_REUPLOAD.has(existing.status)) {
        throw new ConflictException(
          `Release ${existing.id} for version "${manifest.version}" is still in progress (status: "${existing.status}"). ` +
            'Resolve it — let it complete, or roll it back — before uploading this version again.',
        );
      }

      // REPLACEABLE — the only prior attempt(s) at this version never went
      // live (or an earlier staged rollback already reverted ACTIVE back to
      // the previous release; any migrations it ran stay applied — I-8
      // expand-only — and their release_migration_runs rows are untouched
      // here since we reuse, never delete, this row's id).
      const priorStatus = existing.status;
      existing.packageType = packageType;
      existing.baseVersion = manifest.baseVersion ?? null;
      existing.manifest = manifest;
      existing.manifestChecksum = manifestChecksum;
      existing.status = newStatus;
      existing.uploadedByUserId = uploadedByUserId;
      existing.backupRunId = null; // a new attempt needs its own verified backup linked again
      existing.completedAt = errors.length > 0 ? new Date() : null;
      existing.errorMessage = errors.length > 0 ? errors.join('; ') : null;
      const release = await repo.save(existing);

      await this.audit.record({
        actorUserId: uploadedByUserId,
        organizationId: null,
        action: errors.length === 0 ? 'release.re_registered' : 'release.validation_failed',
        resource: 'release',
        resourceId: release.id,
        result: errors.length === 0 ? 'success' : 'denied',
        correlationId: null,
        after: { version: manifest.version, packageType, errors, supersededStatus: priorStatus },
      });

      return release;
    }

    let release: Release;
    try {
      release = await repo.save(
        repo.create({
          version: manifest.version,
          packageType,
          baseVersion: manifest.baseVersion ?? null,
          manifest,
          manifestChecksum,
          status: newStatus,
          uploadedByUserId,
          backupRunId: null,
          completedAt: errors.length > 0 ? new Date() : null,
          errorMessage: errors.length > 0 ? errors.join('; ') : null,
        }),
      );
    } catch (err) {
      if (isPgUniqueViolation(err, 'IDX_releases_version')) {
        // A concurrent upload of the same brand-new version won the race
        // between our read above and this insert — same clean refusal, not
        // a raw 500. The other request's release row is the one of record.
        throw new ConflictException(
          `A release for version "${manifest.version}" was just registered by a concurrent request. Reload and check its status before retrying.`,
        );
      }
      throw err;
    }

    await this.audit.record({
      actorUserId: uploadedByUserId,
      organizationId: null,
      action: errors.length === 0 ? 'release.registered' : 'release.validation_failed',
      resource: 'release',
      resourceId: release.id,
      result: errors.length === 0 ? 'success' : 'denied',
      correlationId: null,
      after: { version: manifest.version, packageType, errors },
    });

    return release;
  }

  /**
   * Ties a specific VERIFIED backup to THIS release — CTO directive:
   * "Backup يجب أن يكون مرتبطًا بالـRelease نفسه، وليس مجرد Backup قديم
   * موجود على السيرفر" (the backup must belong to this release, not just
   * be some old backup that happens to exist on the server). Only a
   * `'validated'` release can be linked; only a backup with an actually
   * `'verified'` database artifact is accepted — re-checked here, not
   * trusted from whatever the caller claims.
   */
  async linkVerifiedBackup(releaseId: string, backupRunId: string, actorUserId: string): Promise<Release> {
    const releaseRepo = this.dataSource.getRepository(Release);
    const artifactRepo = this.dataSource.getRepository(BackupArtifact);

    const release = await releaseRepo.findOne({ where: { id: releaseId } });
    if (!release) throw new NotFoundException(`Release "${releaseId}" not found.`);
    if (release.status !== 'validated') {
      throw new ConflictException(`Release is "${release.status}" — only a "validated" release can be linked to a backup.`);
    }

    const dbArtifact = await artifactRepo.findOne({ where: { backupRunId, type: 'database' } });
    if (!dbArtifact || dbArtifact.status !== 'verified') {
      throw new ConflictException('The selected backup does not have a VERIFIED database artifact — it cannot be linked to this release.');
    }

    release.backupRunId = backupRunId;
    release.status = 'backup_verified';
    const saved = await releaseRepo.save(release);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'release.backup_linked',
      resource: 'release',
      resourceId: release.id,
      result: 'success',
      correlationId: null,
      after: { backupRunId },
    });

    return saved;
  }

  /**
   * The CTO directive's central rule, made literal and enforceable:
   * "No Verified Backup -> No Deployment." Any future
   * deployment-execution code (the next Phase C increment) MUST call this
   * first and stop on a thrown `ConflictException` — nothing in this
   * codebase is authorized to bypass it. Re-checks the LINKED backup's
   * artifact is STILL verified at call time (not just was, once) — a
   * verification could theoretically be superseded/invalidated between
   * linking and the actual deploy attempt.
   */
  async checkDeploymentGate(releaseId: string): Promise<{ allowed: true; backupRunId: string }> {
    const releaseRepo = this.dataSource.getRepository(Release);
    const artifactRepo = this.dataSource.getRepository(BackupArtifact);

    const release = await releaseRepo.findOne({ where: { id: releaseId } });
    if (!release) throw new NotFoundException(`Release "${releaseId}" not found.`);
    if (!release.backupRunId) {
      throw new ConflictException('No backup is linked to this release yet. No Verified Backup -> No Deployment.');
    }

    const dbArtifact = await artifactRepo.findOne({ where: { backupRunId: release.backupRunId, type: 'database' } });
    if (!dbArtifact || dbArtifact.status !== 'verified') {
      throw new ConflictException(
        'The backup linked to this release is no longer verified. No Verified Backup -> No Deployment — re-verify or link a different backup.',
      );
    }

    return { allowed: true, backupRunId: release.backupRunId };
  }
}
