import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Release } from './release.entity';
import { BackupArtifact } from './backup-artifact.entity';
import { ReleaseManifest } from './release-manifest';
import { ReleasePackageType } from './release-status';
import { computeStringChecksum } from './checksum';
import { validateManifest } from './manifest-validation';
import { AuditService } from '../audit/audit.service';

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
   */
  async registerRelease(manifest: ReleaseManifest, packageType: ReleasePackageType, uploadedByUserId: string): Promise<Release> {
    const repo = this.dataSource.getRepository(Release);
    const errors = validateManifest(manifest, packageType);
    const manifestChecksum = computeStringChecksum(JSON.stringify(manifest));

    const release = await repo.save(
      repo.create({
        version: manifest.version,
        packageType,
        baseVersion: manifest.baseVersion ?? null,
        manifest,
        manifestChecksum,
        status: errors.length === 0 ? 'validated' : 'validation_failed',
        uploadedByUserId,
        backupRunId: null,
        completedAt: errors.length > 0 ? new Date() : null,
        errorMessage: errors.length > 0 ? errors.join('; ') : null,
      }),
    );

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
