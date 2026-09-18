import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { ConfigKey, ConfigScopeLevel } from './config-key.entity';
import { ConfigValue } from './config-value.entity';
import { ConfigRegistrySeeder } from './config-registry.seeder';
import { coerce, ConfigCoerceError, looksLikeSecret, serialize } from './config-coerce';
import { customerWritableLevels, ResolveContext, resolveConfig } from './config-resolver';
import { ACTIVE_EDITION_PROVIDER, ActiveEditionProvider } from './active-edition.provider';
import { registerLiveConfigEngine } from './live-config-accessor';
import { AuditService } from '../audit/audit.service';
import { EventBusService } from '../events/event-bus.service';

export interface ConfigContext {
  userId?: string;
  orgId?: string;
}

export interface ConfigScope {
  scope_type: ConfigScopeLevel;
  scope_id?: string | null;
}

export interface ActorRef {
  userId: string | null;
  correlationId?: string | null;
}

/**
 * Runtime Configuration Engine — ERP Foundation P2.
 * planning/erp-foundation/P2_BLUEPRINT.md §4. SEPARATE from boot `AppConfigService`.
 *
 * `get()` is SYNCHRONOUS — it reads an in-process cache populated on boot and
 * refreshed on `configuration.changed`. Business modules READ ONLY; they never
 * touch the tables (same rule as the Permission Engine and Release Center).
 */
@Injectable()
export class ConfigurationEngineService implements OnModuleInit {
  private readonly logger = new Logger(ConfigurationEngineService.name);
  private registry = new Map<string, ConfigKey>();
  private values = new Map<string, ConfigValue[]>(); // key -> active rows
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(ConfigKey) private readonly keyRepo: Repository<ConfigKey>,
    @InjectRepository(ConfigValue) private readonly valueRepo: Repository<ConfigValue>,
    private readonly dataSource: DataSource,
    private readonly seeder: ConfigRegistrySeeder,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    @Inject(ACTIVE_EDITION_PROVIDER) private readonly activeEdition: ActiveEditionProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seeder.sync();
    await this.reload();
    // AUDIT-SEC-26 fix — see live-config-accessor.ts's own doc comment for
    // why this is needed: registered only after the cache is populated, so
    // any reader reaching this instance always sees real values, never an
    // empty pre-load cache.
    registerLiveConfigEngine(this);
    const seconds = this.numberOrDefault('core.config.cache_reload_seconds', 300);
    this.reloadTimer = setInterval(() => {
      this.reload().catch((e) => this.logger.warn(`config cache reload failed: ${(e as Error).message}`));
    }, seconds * 1000);
    this.reloadTimer.unref?.();
  }

  /**
   * Re-run the registry seeder then reload the cache. Called by the Release
   * Engine's "enable Module M" deploy step (ERP Foundation P6) so a
   * newly-entitled module's `config_keys` exist and resolve on the first
   * post-deploy request, not only after the next process restart. Idempotent
   * (the seeder is additive/archive-on-remove) — safe to call any time.
   */
  async resyncRegistry(): Promise<{ added: string[]; removed: string[]; changed: string[] }> {
    const r = await this.seeder.sync();
    await this.reload();
    return r;
  }

  /** Full reload of the in-process cache (registry + active values). */
  async reload(): Promise<void> {
    const [keyRows, valueRows] = await Promise.all([this.keyRepo.find(), this.valueRepo.find({ where: { archivedAt: IsNull() } })]);
    this.registry = new Map(keyRows.map((k) => [k.key, k]));
    const grouped = new Map<string, ConfigValue[]>();
    for (const v of valueRows) {
      const arr = grouped.get(v.key) ?? [];
      arr.push(v);
      grouped.set(v.key, arr);
    }
    this.values = grouped;
  }

  // ---- reads -------------------------------------------------------------

  get<T = unknown>(key: string, ctx?: ConfigContext): T {
    const meta = this.mustKey(key);
    const resolved = resolveConfig(meta, this.values.get(key) ?? [], this.toResolveCtx(ctx));
    try {
      return coerce(resolved.raw, { type: meta.valueType, allowed: meta.allowed }) as T;
    } catch (e) {
      if (e instanceof ConfigCoerceError) {
        this.logger.warn(`config "${key}" value from ${resolved.source} no longer coerces (${e.message}) — falling back to default`);
        return coerce(meta.defaultValue, { type: meta.valueType, allowed: meta.allowed }) as T;
      }
      throw e;
    }
  }

  getAll(prefix = '', ctx?: ConfigContext): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of this.registry.keys()) {
      if (key.startsWith(prefix)) out[key] = this.get(key, ctx);
    }
    return out;
  }

  isEnabled(flagKey: string, ctx?: ConfigContext): boolean {
    const meta = this.mustKey(flagKey);
    if (!meta.isFeatureFlag) throw new BadRequestException(`"${flagKey}" is not a feature flag`);
    return this.get<boolean>(flagKey, ctx);
  }

  describe(key: string): ConfigKey {
    return this.mustKey(key);
  }

  keys(ownerModule?: string): ConfigKey[] {
    const all = [...this.registry.values()];
    return ownerModule ? all.filter((k) => k.ownerModule === ownerModule) : all;
  }

  /** For the admin screen — the resolved value + which level supplied it. */
  inspect(key: string, ctx?: ConfigContext): { meta: ConfigKey; value: unknown; source: string } {
    const meta = this.mustKey(key);
    const resolved = resolveConfig(meta, this.values.get(key) ?? [], this.toResolveCtx(ctx));
    return { meta, value: this.get(key, ctx), source: resolved.source };
  }

  // ---- writes ----------------------------------------------------------

  async set(key: string, scope: ConfigScope, value: unknown, actor: ActorRef): Promise<void> {
    const meta = this.mustKey(key);
    const scopeType = scope.scope_type;
    const scopeId = scope.scope_id ?? null;

    // scope-level allowed for this key?
    if (!meta.scopeLevels.includes(scopeType)) {
      await this.auditDenied(key, scope, actor, `scope "${scopeType}" not permitted for this key`);
      throw new ConflictException(`Setting "${key}" cannot be set at scope "${scopeType}".`);
    }
    // platform_locked: customer-facing levels are Daii-managed
    if (meta.platformLocked && (scopeType === 'user' || scopeType === 'org' || scopeType === 'installation')) {
      await this.auditDenied(key, scope, actor, 'platform_locked — managed by the platform');
      throw new ConflictException(`Setting "${key}" is managed by Daii and cannot be changed here.`);
    }
    // secret-shaped value
    let text: string;
    try {
      text = serialize(value, { type: meta.valueType, allowed: meta.allowed });
    } catch (e) {
      throw new BadRequestException(`Invalid value for "${key}": ${(e as Error).message}`);
    }
    if ((meta.valueType === 'string' || meta.valueType === 'json') && looksLikeSecret(text)) {
      await this.auditDenied(key, scope, actor, 'value looks like a secret');
      throw new BadRequestException('Secrets belong in deployment configuration, not the Configuration Engine.');
    }
    // singleton scopes must not carry a scope_id; the others must
    if ((scopeType === 'platform' || scopeType === 'installation') && scopeId !== null) {
      throw new BadRequestException(`scope "${scopeType}" does not take a scope_id`);
    }
    if ((scopeType === 'user' || scopeType === 'org' || scopeType === 'edition') && !scopeId) {
      throw new BadRequestException(`scope "${scopeType}" requires a scope_id`);
    }

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ConfigValue);
      const existing = await repo.findOne({
        where: { key, scopeType, scopeId: scopeId === null ? IsNull() : scopeId, archivedAt: IsNull() },
      });
      const before = existing?.value ?? null;
      if (existing) {
        existing.value = text;
        existing.setByUserId = actor.userId;
        existing.setAt = new Date();
        await repo.save(existing);
      } else {
        await repo.save(repo.create({ key, scopeType, scopeId, value: text, setByUserId: actor.userId, archivedAt: null }));
      }
      await this.audit.record(
        {
          actorUserId: actor.userId,
          organizationId: scopeType === 'org' ? scopeId : null,
          action: 'configuration.value.set',
          resource: 'config_key',
          resourceId: key,
          result: 'success',
          correlationId: actor.correlationId ?? null,
          before: { scope, value: before },
          after: { scope, value: text, platform_locked: meta.platformLocked, security_sensitive: meta.securitySensitive },
        },
        manager,
      );
      await this.events.publish(manager, 'configuration.changed', { key, scopeType, scopeId });
    });

    await this.reload();
  }

  async clear(key: string, scope: ConfigScope, actor: ActorRef): Promise<void> {
    const meta = this.mustKey(key);
    const scopeType = scope.scope_type;
    const scopeId = scope.scope_id ?? null;

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ConfigValue);
      const existing = await repo.findOne({
        where: { key, scopeType, scopeId: scopeId === null ? IsNull() : scopeId, archivedAt: IsNull() },
      });
      if (!existing) return;
      await repo.remove(existing);
      await this.audit.record(
        {
          actorUserId: actor.userId,
          organizationId: scopeType === 'org' ? scopeId : null,
          action: 'configuration.value.cleared',
          resource: 'config_key',
          resourceId: key,
          result: 'success',
          correlationId: actor.correlationId ?? null,
          before: { scope, value: existing.value },
          after: { scope, value: null },
        },
        manager,
      );
      await this.events.publish(manager, 'configuration.changed', { key, scopeType, scopeId });
    });

    void meta;
    await this.reload();
  }

  /** Levels a non-Daii admin may write for this key (empty when platform_locked). */
  writableLevels(key: string): ConfigScopeLevel[] {
    return customerWritableLevels(this.mustKey(key));
  }

  // ---- internals ------------------------------------------------------

  private mustKey(key: string): ConfigKey {
    const meta = this.registry.get(key);
    if (!meta) throw new NotFoundException(`Unknown configuration key "${key}".`);
    return meta;
  }

  private toResolveCtx(ctx?: ConfigContext): ResolveContext {
    const orgScopeOn = this.registry.has('core.config.org_scope_enabled') ? this.getRawBool('core.config.org_scope_enabled') : false;
    return {
      userId: ctx?.userId ?? null,
      orgAncestry: orgScopeOn && ctx?.orgId ? [ctx.orgId] : [], // ORG-tree walk is deferred — P2_BLUEPRINT §0.2
      activeEdition: this.activeEdition.getActiveEditionCode(),
    };
  }

  private getRawBool(key: string): boolean {
    const meta = this.registry.get(key);
    if (!meta) return false;
    const resolved = resolveConfig(meta, this.values.get(key) ?? [], { activeEdition: this.activeEdition.getActiveEditionCode() });
    return resolved.raw.trim().toLowerCase() === 'true' || resolved.raw.trim() === '1';
  }

  private numberOrDefault(key: string, fallback: number): number {
    try {
      const n = this.get<number>(key);
      return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  }

  private async auditDenied(key: string, scope: ConfigScope, actor: ActorRef, reason: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const meta = this.registry.get(key);
      await this.audit.record(
        {
          actorUserId: actor.userId,
          organizationId: null,
          action: 'configuration.value.set',
          resource: 'config_key',
          resourceId: key,
          result: 'denied',
          correlationId: actor.correlationId ?? null,
          after: { scope, reason, security_sensitive: meta?.securitySensitive ?? false },
        },
        manager,
      );
      if (meta?.securitySensitive) {
        await this.events.publish(manager, 'security.configuration.denied', { key, scope, reason });
      }
    });
  }
}
