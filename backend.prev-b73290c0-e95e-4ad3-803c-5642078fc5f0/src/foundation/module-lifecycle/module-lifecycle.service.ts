import { Injectable, Logger } from '@nestjs/common';
import { EntitlementService } from '../entitlement/entitlement.service';
import { EntitlementManifest } from '../entitlement/manifest.type';
import { ConfigurationEngineService } from '../configuration-engine/configuration-engine.service';
import { MODULE_REGISTRY } from '../module-registry/module-registry';
import { LimitService } from '../limit-engine/limit.service';
import { ModuleRoleTemplateSeeder } from '../module-role-templates/module-role-template.seeder';
import { AuditService } from '../audit/audit.service';

export interface EnableModulesResult {
  /** module_codes (incl. depends_on closure) that were not entitled before and are now. */
  modulesAdded: string[];
  /** module_codes that WERE entitled and are not after this manifest — a downgrade. Data is retained (ADR-023 O-5). */
  modulesRemoved: string[];
  rolesSeeded: number;
  grantsSeeded: number;
  configKeysAdded: string[];
  configOverridesApplied: string[];
  configOverridesArchived: string[];
}

/**
 * ERP Foundation P6 (T2) — the "enable Module M" lifecycle step, factored out
 * of the Release Engine so the deploy orchestrator (`ReleaseExecutionService`)
 * depends on ONE cohesive service instead of four.
 *
 * It performs NO enforcement decision of its own — Entitlement
 * (`@RequireModule`/`@RequireFeature`) and Permission (`@RequirePermission`)
 * remain the only gates. This service just makes a newly-entitled module
 * *usable on the first post-deploy request*: its manifest already carries
 * what the module owns (P3), this seeds the derived rows the module's routes
 * expect — system role templates (P4-T1), `config_keys` (P2), limit profiles
 * (P5) — each via that engine's own **idempotent, additive** seeder.
 *
 * Called only from inside the Release Engine's deploy pipeline, under the
 * existing backup / health / smoke / expand-contract gates (ADR-023 Part D —
 * extend the seam, don't refactor the engine).
 */
@Injectable()
export class ModuleLifecycleService {
  private readonly logger = new Logger(ModuleLifecycleService.name);

  constructor(
    private readonly entitlement: EntitlementService,
    private readonly configEngine: ConfigurationEngineService,
    private readonly limits: LimitService,
    private readonly roleTemplates: ModuleRoleTemplateSeeder,
    private readonly audit: AuditService,
  ) {}

  /**
   * Apply a verified entitlement manifest to the `installation` row and, for
   * every module that becomes entitled as a result, run its enable-Module
   * seeding. The manifest MUST already be signature-verified by the caller
   * (the deploy step verifies it pre-swap before writing the file that
   * `readEnabledModules` reads for the migration glob).
   */
  async applyEntitlementAndEnableModules(
    manifest: EntitlementManifest,
    signatureB64: string,
    actorUserId: string | null,
  ): Promise<EnableModulesResult> {
    const before = new Set(this.entitlement.resolve().modules);
    // expandClosure: the deploy has already run the closure's migrations (the
    // migration glob used the same closure), so accept-with-note rather than reject.
    await this.entitlement.applyManifest(manifest, signatureB64, actorUserId, { expandClosure: true });
    const after = this.entitlement.resolve().modules;
    const modulesAdded = [...after].filter((m) => !before.has(m) && m !== 'core');
    const modulesRemoved = [...before].filter((m) => !after.has(m) && m !== 'core');

    const result = await this.enableModules(modulesAdded, actorUserId);

    // P8 — `config_overrides` seeding (EDITION scope, D-P8-1): Edition policy
    // defaults that the customer's own INSTALLATION/USER values still override.
    const configOverridesApplied = await this.applyConfigOverrides(manifest, actorUserId);

    // P8 — downgrade (ADR-023 O-5): NO destructive action. Data, migrations,
    // role templates, limit profiles for a now-absent module are all RETAINED
    // and inert (routes 404 via the Entitlement guard). The only cleanup is
    // archiving that module's EDITION-scope config overrides so a stale
    // Edition value cannot leak (INSTALLATION/USER values are the customer's,
    // untouched — D-P8-2).
    const configOverridesArchived =
      modulesRemoved.length > 0 ? await this.archiveEditionOverridesFor(modulesRemoved, manifest.edition_code, actorUserId) : [];

    if (modulesRemoved.length > 0) {
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'entitlement.modules_disabled',
        resource: 'installation',
        resourceId: manifest.installation_id,
        result: 'success',
        correlationId: null,
        after: { modulesRemoved, dataRetained: true, migrationsReverted: false, configOverridesArchived },
      });
      this.logger.log(
        `downgrade: module(s) ${modulesRemoved.join(', ')} no longer entitled — data RETAINED, routes now 404 (ADR-023 O-5)`,
      );
    }

    return {
      ...result,
      modulesAdded,
      modulesRemoved,
      configOverridesApplied,
      configOverridesArchived,
    };
  }

  /** Seed `manifest.config_overrides` as EDITION-scope config values. Unknown keys are skipped with a warning. Idempotent (overwrites the same edition-scope row). */
  private async applyConfigOverrides(manifest: EntitlementManifest, actorUserId: string | null): Promise<string[]> {
    const overrides = manifest.config_overrides ?? {};
    const applied: string[] = [];
    for (const [key, value] of Object.entries(overrides)) {
      try {
        await this.configEngine.set(
          key,
          { scope_type: 'edition', scope_id: manifest.edition_code },
          value,
          { userId: actorUserId ?? 'system' },
        );
        applied.push(key);
      } catch (e) {
        this.logger.warn(`config_override "${key}" skipped: ${(e as Error).message}`);
      }
    }
    if (applied.length) await this.configEngine.reload();
    return applied;
  }

  /** Archive EDITION-scope config values for every config_key owned by a now-absent module. */
  private async archiveEditionOverridesFor(
    removedModules: string[],
    editionCode: string,
    actorUserId: string | null,
  ): Promise<string[]> {
    const archived: string[] = [];
    for (const code of removedModules) {
      const manifest = MODULE_REGISTRY.manifest(code as never);
      for (const ck of manifest?.config_keys ?? []) {
        try {
          await this.configEngine.clear(ck.key, { scope_type: 'edition', scope_id: editionCode }, { userId: actorUserId ?? 'system' });
          archived.push(ck.key);
        } catch {
          /* no edition-scope row for this key — nothing to archive */
        }
      }
    }
    if (archived.length) await this.configEngine.reload();
    return archived;
  }

  /** Re-resolve the Entitlement Engine cache from the (possibly just-restored) `installation` row + manifest file. Used by the Release Engine's rollback path. */
  async reloadEntitlement(): Promise<void> {
    await this.entitlement.reload();
  }

  /** Seed the derived rows a set of newly-entitled modules need. Idempotent. */
  async enableModules(
    moduleCodes: string[],
    actorUserId: string | null,
  ): Promise<{ rolesSeeded: number; grantsSeeded: number; configKeysAdded: string[] }> {
    let rolesSeeded = 0;
    let grantsSeeded = 0;
    for (const code of moduleCodes) {
      const r = await this.roleTemplates.seedForModule(code);
      rolesSeeded += r.roles;
      grantsSeeded += r.grants;
    }
    // config + limit registries are seeded from the FULL manifest set in one
    // pass each (the seeders iterate every authored module themselves)
    const cfg = moduleCodes.length ? await this.configEngine.resyncRegistry() : { added: [] as string[] };
    if (moduleCodes.length) await this.limits.resyncRegistry();

    if (moduleCodes.length) {
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'release.deploy.modules_enabled',
        resource: 'installation',
        resourceId: null,
        result: 'success',
        correlationId: null,
        after: { modules: moduleCodes, rolesSeeded, grantsSeeded, configKeysAdded: cfg.added },
      });
      this.logger.log(
        `enabled module(s) ${moduleCodes.join(', ')}: +${rolesSeeded} role(s), +${grantsSeeded} grant(s), +${cfg.added.length} config key(s)`,
      );
    }
    return { rolesSeeded, grantsSeeded, configKeysAdded: cfg.added };
  }
}
