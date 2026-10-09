import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Installation, INSTALLATION_SINGLETON_ID } from './installation.entity';
import { DAII_STANDARD_EDITION } from './manifest.type';
import { computeInstallationFingerprint } from './installation-fingerprint';
import { AppConfigService } from '../configuration/app-config.service';
import { AuditService } from '../audit/audit.service';

export type InstallationBootstrapOutcome =
  /** this call created the implicit row */
  | 'created'
  /** a row already exists (implicit or licensed) — never touched */
  | 'present'
  /** `enforced` mode and no row: a licence must be applied through the signed-manifest path — nothing is invented */
  | 'absent_enforced';

/**
 * Installation initialisation (post-incident review of release 1.1.4, 2026-10-09).
 *
 * `companies.installationId` has a foreign key to the platform `installation` row, but nothing in a deployment ever created that row: the only writer was
 * `EntitlementService.applyManifest` (a signed licence). On a platform database that never had a licence applied, `ENTITLEMENT_MODE=unlicensed-full` (the default)
 * ran the whole application on the in-memory `implicitStandard` edition — and creating a Company then failed with a foreign-key violation, surfaced to the operator
 * only as "An unexpected error occurred".
 *
 * The design ALREADY has a first-class representation of that state: `EntitlementService.reload()` treats a row with `editionCode = DAII_STANDARD` and **no
 * signature** as `implicitStandard('unlicensed')`. This service makes the database say what the application is already doing — nothing more:
 *   - `unlicensed-full`: ensure that unsigned DAII_STANDARD row exists (`INSERT … ON CONFLICT DO NOTHING`: idempotent, safe under concurrent starts, never overwrites
 *     anything). It carries no manifest, no signature, no kid, `verificationState = 'unlicensed'` — it is NOT a licence, grants nothing the implicit edition did not
 *     already grant, and a later `applyManifest` simply replaces it.
 *   - `enforced`: NEVER creates a row. A missing licence stays a missing licence (the service reports `absent_enforced`); the signed-manifest path is the only way in.
 * The foreign key, the signature verification and the entitlement semantics are unchanged.
 */
@Injectable()
export class InstallationBootstrapService {
  private readonly logger = new Logger(InstallationBootstrapService.name);

  constructor(
    @InjectRepository(Installation) private readonly installations: Repository<Installation>,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  async ensure(): Promise<InstallationBootstrapOutcome> {
    if (this.config.entitlement.mode !== 'unlicensed-full') {
      const exists = (await this.installations.count({ where: { id: INSTALLATION_SINGLETON_ID } })) > 0;
      if (!exists) this.logger.warn('ENTITLEMENT_MODE=enforced and no installation row: NOT creating one — apply a signed entitlement manifest (POST /api/admin/entitlement/apply).');
      return exists ? 'present' : 'absent_enforced';
    }

    const installationId = `implicit-${computeInstallationFingerprint().slice(0, 32)}`;
    const inserted: Array<{ id: string }> = await this.installations.query(
      `INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","status","graceDays","entitlementManifest","manifestSignature","manifestKid","issuedAt","verificationState")
       VALUES ($1,$2,$3,$4,$5,'active',0,'{}'::jsonb,NULL,NULL,NULL,'unlicensed')
       ON CONFLICT ("id") DO NOTHING
       RETURNING "id"`,
      [INSTALLATION_SINGLETON_ID, installationId, 'Unlicensed installation (implicit DAII_STANDARD)', DAII_STANDARD_EDITION, '1.0.0'],
    );
    if (inserted.length === 0) return 'present';

    this.logger.log(`Initialised the implicit unlicensed installation row (${installationId}); required by companies.installationId.`);
    try {
      await this.audit.record({
        actorUserId: null,
        organizationId: null,
        action: 'entitlement.installation.initialized',
        resource: 'installation',
        resourceId: installationId,
        result: 'success',
        correlationId: null,
        after: { mode: 'unlicensed-full', edition: DAII_STANDARD_EDITION, signed: false, verificationState: 'unlicensed', reason: 'implicit unsigned row; companies.installationId foreign key target' },
      });
    } catch (err) {
      // the row is what matters; a failed audit write must not stop the application from starting — it is logged loudly instead
      this.logger.error(`Installation row created but its audit record failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 'created';
  }
}
