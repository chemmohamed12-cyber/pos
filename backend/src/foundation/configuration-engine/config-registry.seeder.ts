import { Injectable, Logger } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { ConfigKey } from './config-key.entity';
import { ConfigValue } from './config-value.entity';
import { ConfigKeySource } from './config-key-source.type';
import { CORE_CONFIG_KEYS } from './core-config-keys';
import { serialize } from './config-coerce';
import { MODULE_REGISTRY } from '../module-registry/module-registry';
import { AuditService } from '../audit/audit.service';

/**
 * Rebuilds `config_keys` from code on every boot (P2_BLUEPRINT.md §5).
 * Idempotent: run twice -> identical rows. A key with no code source is
 * removed and its `config_values` are ARCHIVED (never hard-deleted —
 * Governance Rule 13). Writes one `configuration.registry.synced` audit row
 * with a diff summary.
 */
@Injectable()
export class ConfigRegistrySeeder {
  private readonly logger = new Logger(ConfigRegistrySeeder.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** The composed code registry: CORE_CONFIG_KEYS ∪ every authored module's config_keys. */
  static composeSources(): ConfigKeySource[] {
    const sources: ConfigKeySource[] = [...CORE_CONFIG_KEYS];
    for (const code of MODULE_REGISTRY.authoredModuleCodes()) {
      const manifest = MODULE_REGISTRY.manifest(code);
      if (!manifest) continue;
      for (const ck of manifest.config_keys) {
        sources.push({
          key: ck.key,
          ownerModule: code,
          valueType: ck.type,
          allowed: ck.allowed as ConfigKeySource['allowed'],
          default: ck.default,
          scopeLevels: ck.scope_levels,
          platformLocked: ck.platform_locked ?? false,
          titleCode: ck.key.replace(/\./g, '_'),
        });
      }
    }
    const seen = new Set<string>();
    for (const s of sources) {
      if (seen.has(s.key)) throw new Error(`ConfigRegistrySeeder: duplicate config key "${s.key}" across sources`);
      seen.add(s.key);
    }
    return sources;
  }

  async sync(): Promise<{ added: string[]; removed: string[]; changed: string[] }> {
    const sources = ConfigRegistrySeeder.composeSources();
    const bySourceKey = new Map(sources.map((s) => [s.key, s]));

    return this.dataSource.transaction(async (manager) => {
      const keyRepo = manager.getRepository(ConfigKey);
      const valueRepo = manager.getRepository(ConfigValue);
      const existing = await keyRepo.find();
      const existingByKey = new Map(existing.map((k) => [k.key, k]));

      const added: string[] = [];
      const changed: string[] = [];
      const removed: string[] = [];

      for (const s of sources) {
        const row = this.toRow(s);
        const prev = existingByKey.get(s.key);
        if (!prev) {
          await keyRepo.save(keyRepo.create(row));
          added.push(s.key);
        } else if (!this.rowEquals(prev, row)) {
          await keyRepo.save(keyRepo.create({ ...prev, ...row }));
          changed.push(s.key);
        }
      }

      for (const k of existing) {
        if (!bySourceKey.has(k.key)) {
          await keyRepo.delete({ key: k.key });
          await valueRepo.update({ key: k.key, archivedAt: IsNull() }, { archivedAt: new Date() });
          removed.push(k.key);
        }
      }

      if (added.length || changed.length || removed.length) {
        await this.audit.record(
          {
            actorUserId: null,
            organizationId: null,
            action: 'configuration.registry.synced',
            resource: 'config_keys',
            resourceId: null,
            result: 'success',
            correlationId: null,
            after: { added, changed, removed, total: sources.length },
          },
          manager,
        );
        this.logger.log(`config_keys synced: +${added.length} ~${changed.length} -${removed.length} (${sources.length} total)`);
      }
      return { added, removed, changed };
    });
  }

  private toRow(s: ConfigKeySource): Partial<ConfigKey> {
    return {
      key: s.key,
      ownerModule: s.ownerModule,
      valueType: s.valueType,
      allowed: (s.allowed ?? null) as ConfigKey['allowed'],
      defaultValue: serialize(s.default, { type: s.valueType, allowed: s.allowed }),
      scopeLevels: [...s.scopeLevels],
      platformLocked: s.platformLocked ?? false,
      securitySensitive: s.securitySensitive ?? false,
      isFeatureFlag: s.isFeatureFlag ?? false,
      titleCode: s.titleCode,
      description: s.description ?? null,
      flagOwner: s.flagOwner ?? null,
      flagRemoveBy: s.flagRemoveBy ?? null,
    };
  }

  private rowEquals(a: ConfigKey, b: Partial<ConfigKey>): boolean {
    return (
      a.ownerModule === b.ownerModule &&
      a.valueType === b.valueType &&
      JSON.stringify(a.allowed ?? null) === JSON.stringify(b.allowed ?? null) &&
      a.defaultValue === b.defaultValue &&
      JSON.stringify(a.scopeLevels) === JSON.stringify(b.scopeLevels) &&
      a.platformLocked === b.platformLocked &&
      a.securitySensitive === b.securitySensitive &&
      a.isFeatureFlag === b.isFeatureFlag &&
      a.titleCode === b.titleCode &&
      (a.description ?? null) === (b.description ?? null) &&
      (a.flagOwner ?? null) === (b.flagOwner ?? null) &&
      (a.flagRemoveBy ?? null) === (b.flagRemoveBy ?? null)
    );
  }
}
