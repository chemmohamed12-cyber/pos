import { BadRequestException, ConflictException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Installation, INSTALLATION_SINGLETON_ID } from './installation.entity';
import { verifyManifest } from './manifest-verify';
import { DAII_STANDARD_EDITION, EntitlementManifest } from './manifest.type';
import { computeInstallationFingerprint } from './installation-fingerprint';
import { EntitlementResolver } from '../module-registry/entitlement-resolver.token';
import { MODULE_REGISTRY } from '../module-registry/module-registry';
import { AppConfigService } from '../configuration/app-config.service';
import { AuditService } from '../audit/audit.service';
import { EventBusService } from '../events/event-bus.service';

export interface ResolvedEntitlement {
  editionCode: string;
  editionVersion: string;
  status: 'active' | 'suspended' | 'expired';
  verificationState: 'verified' | 'unlicensed' | 'invalid';
  modules: ReadonlySet<string>;
  features: ReadonlySet<string>;
  limits: ReadonlyMap<string, number | null>;
}

/**
 * Entitlement Engine — ERP Foundation P3. Resolves "what does this
 * installation OWN" from the single `installation` row's signed manifest.
 * This is the FIRST, INDEPENDENT axis (ADR-023 §3 — Edition ≠ Permission).
 *
 * The installation is a singleton, so `resolve()` returns an in-process
 * cached value, rebuilt on `entitlement.changed` and on `applyManifest`.
 */
@Injectable()
export class EntitlementService implements OnModuleInit, EntitlementResolver {
  private readonly logger = new Logger(EntitlementService.name);
  private cache: ResolvedEntitlement = EntitlementService.coreOnly('invalid');

  constructor(
    @InjectRepository(Installation) private readonly installations: Repository<Installation>,
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  // ---- EntitlementResolver (consumed by the P1 guards + P2 config seam) ----

  isModuleEntitled(moduleCode: string): boolean {
    if (moduleCode === 'core') return true;
    return this.cache.status === 'active' && this.cache.modules.has(moduleCode);
  }

  isFeatureEntitled(featureCode: string): boolean {
    if (this.cache.status !== 'active') return false;
    // a non-toggleable (structural) feature is always entitled if its module is
    const moduleCode = featureCode.split('.')[0];
    const meta = MODULE_REGISTRY.manifest(moduleCode as never);
    const featureMeta = meta?.feature_codes.find((f) => f.code === featureCode);
    if (featureMeta && !featureMeta.toggleable) return this.isModuleEntitled(moduleCode);
    return this.cache.features.has(featureCode);
  }

  activeEditionCode(): string | null {
    return this.cache.editionCode || null;
  }

  // ---- resolution ----

  resolve(): ResolvedEntitlement {
    return this.cache;
  }

  async reload(): Promise<void> {
    const row = await this.installations.findOne({ where: { id: INSTALLATION_SINGLETON_ID } });
    const ent = this.config.entitlement;

    if (!row) {
      if (ent.mode === 'unlicensed-full') {
        this.cache = this.implicitStandard('unlicensed');
        this.logger.log('No entitlement manifest — running the implicit DAII_STANDARD edition (ENTITLEMENT_MODE=unlicensed-full).');
      } else {
        this.cache = EntitlementService.coreOnly('invalid');
        await this.alarm('security.entitlement.missing', { mode: 'enforced' });
        this.logger.error('ENTITLEMENT_MODE=enforced and NO manifest present — failing closed to Core-only.');
      }
      return;
    }

    // a row exists → verify
    if (row.editionCode === DAII_STANDARD_EDITION && !row.manifestSignature) {
      // an explicitly-applied implicit-standard row (test/dev) — trust it
      this.cache = this.implicitStandard('unlicensed');
      return;
    }

    const result = verifyManifest(JSON.stringify(row.entitlementManifest), row.manifestSignature, {
      publicKeys: ent.publicKeys,
      clockToleranceMinutes: ent.clockToleranceMinutes,
      lastTrustedAtMs: row.lastTrustedAt?.getTime() ?? null,
      currentFingerprint: computeInstallationFingerprint(),
    });

    if (!result.ok) {
      this.cache = EntitlementService.coreOnly('invalid');
      await this.alarm('security.entitlement.invalid', { reason: result.reason, detail: result.detail });
      this.logger.error(`Entitlement manifest INVALID (${result.reason}) — failing closed to Core-only.`);
      // persist the invalid state (do not touch lastTrustedAt)
      await this.installations.update({ id: INSTALLATION_SINGLETON_ID }, { verificationState: 'invalid' });
      return;
    }

    this.cache = this.fromManifest(result.manifest, 'verified');
    await this.installations.update(
      { id: INSTALLATION_SINGLETON_ID },
      { verificationState: 'verified', lastTrustedAt: new Date(), status: this.cache.status },
    );
  }

  // ---- operator: apply a manifest (called by P6's deploy step) ----

  async applyManifest(
    manifestObj: EntitlementManifest,
    signatureB64: string,
    actorUserId: string | null,
    opts: { expandClosure?: boolean } = {},
  ): Promise<ResolvedEntitlement> {
    const ent = this.config.entitlement;
    const result = verifyManifest(JSON.stringify(manifestObj), signatureB64, {
      publicKeys: ent.publicKeys,
      clockToleranceMinutes: ent.clockToleranceMinutes,
      lastTrustedAtMs: null,
      currentFingerprint: computeInstallationFingerprint(),
    });
    if (!result.ok) {
      await this.alarm('security.entitlement.apply_rejected', { reason: result.reason, detail: result.detail });
      throw new BadRequestException(`Entitlement manifest rejected: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
    }
    const manifest = result.manifest;

    // Replay protection (Commercial Release Gate): reject a manifest whose
    // license_version is OLDER than what's already applied — otherwise a
    // still-validly-signed but superseded manifest (e.g. a downgrade attack,
    // or a stale backup of an older license file) could be re-applied after
    // a newer one was issued. Equal is allowed (idempotent re-apply of the
    // SAME license, relied on by the Release Engine's own re-deploy path);
    // only strictly-older is rejected. A fresh install (no existing row) has
    // nothing to compare against.
    const existing = await this.installations.findOne({ where: { id: INSTALLATION_SINGLETON_ID } });
    if (existing && manifest.license_version < existing.entitlementManifest?.license_version) {
      await this.alarm('security.entitlement.replay_rejected', {
        attemptedVersion: manifest.license_version,
        currentVersion: existing.entitlementManifest?.license_version,
      });
      throw new BadRequestException(
        `Entitlement manifest rejected: license_version ${manifest.license_version} is older than the currently-applied ${existing.entitlementManifest?.license_version} (replay of a superseded license).`,
      );
    }

    // F-MOD-2: reject a manifest that omits a hard dependency of an included module
    const requested = new Set(manifest.module_codes);
    const missing = new Set<string>();
    for (const m of manifest.module_codes) {
      for (const dep of MODULE_REGISTRY.dependencyClosureOf(m as never)) {
        if (!requested.has(dep)) missing.add(dep);
      }
    }
    if (missing.size && !opts.expandClosure) {
      throw new ConflictException(
        `Manifest enables ${[...requested].join(', ')} but omits their hard dependencies: ${[...missing].join(', ')}. ` +
          `Re-issue with these included, or apply with expandClosure=true (F-MOD-2 — decoupling is P4).`,
      );
    }

    // The manifest is stored EXACTLY as signed (mutating it would break the
    // signature). The depends_on closure is applied at RESOLUTION time
    // (`fromManifest`) — so the resolved module set is the closure regardless,
    // and `expandClosure` here only governs whether an incomplete manifest is
    // rejected or accepted-with-a-note.
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Installation);
      await repo.save(
        repo.create({
          id: INSTALLATION_SINGLETON_ID,
          installationId: manifest.installation_id,
          customerName: manifest.customer_name,
          editionCode: manifest.edition_code,
          editionVersion: manifest.edition_version,
          status: 'active',
          termStart: manifest.term_start ? new Date(manifest.term_start) : null,
          termEnd: manifest.term_end ? new Date(manifest.term_end) : null,
          graceDays: manifest.grace_days ?? 0,
          entitlementManifest: manifest,
          manifestSignature: signatureB64,
          manifestKid: manifest.kid,
          issuedAt: new Date(manifest.issued_at),
          lastTrustedAt: new Date(),
          verificationState: 'verified',
        }),
      );
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'entitlement.manifest.applied',
          resource: 'installation',
          resourceId: manifest.installation_id,
          result: 'success',
          correlationId: null,
          after: { edition: manifest.edition_code, version: manifest.edition_version, requestedModules: [...requested], closureAdded: [...missing] },
        },
        manager,
      );
      await this.events.publish(manager, 'entitlement.changed', { editionCode: manifest.edition_code });
    });

    await this.reload();
    return this.cache;
  }

  // ---- helpers ----

  private fromManifest(m: EntitlementManifest, verificationState: 'verified'): ResolvedEntitlement {
    const modules = new Set(m.module_codes);
    for (const mod of [...modules]) for (const dep of MODULE_REGISTRY.dependencyClosureOf(mod as never)) modules.add(dep);
    const limits = new Map<string, number | null>(Object.entries(m.limits ?? {}));
    const now = Date.now();
    const expired = m.term_end ? now > Date.parse(m.term_end) + (m.grace_days ?? 0) * 86_400_000 : false;
    return {
      editionCode: m.edition_code,
      editionVersion: m.edition_version,
      status: expired ? 'expired' : 'active',
      verificationState,
      modules,
      features: new Set(m.feature_codes ?? []),
      limits,
    };
  }

  private implicitStandard(verificationState: 'unlicensed'): ResolvedEntitlement {
    const modules = new Set(MODULE_REGISTRY.authoredModuleCodes());
    const features = new Set<string>();
    for (const code of MODULE_REGISTRY.authoredModuleCodes()) {
      for (const f of MODULE_REGISTRY.manifest(code)!.feature_codes) if (f.default) features.add(f.code);
    }
    return {
      editionCode: DAII_STANDARD_EDITION,
      editionVersion: '1.0.0',
      status: 'active',
      verificationState,
      modules,
      features,
      limits: new Map(),
    };
  }

  private static coreOnly(verificationState: 'invalid'): ResolvedEntitlement {
    return {
      editionCode: '',
      editionVersion: '',
      status: 'suspended',
      verificationState,
      modules: new Set(),
      features: new Set(),
      limits: new Map(),
    };
  }

  private async alarm(action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        await this.audit.record(
          { actorUserId: null, organizationId: null, action, resource: 'installation', resourceId: null, result: 'denied', correlationId: null, after: detail },
          manager,
        );
        await this.events.publish(manager, action, detail);
      });
    } catch (e) {
      this.logger.error(`failed to record entitlement alarm ${action}: ${(e as Error).message}`);
    }
  }
}
