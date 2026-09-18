import { ConfigKey, ConfigScopeLevel } from './config-key.entity';
import { ConfigValue } from './config-value.entity';

/**
 * The PURE precedence resolver. P2_BLUEPRINT.md §3.
 *
 *   USER  ⊕  ORG(walk)  ⊕  INSTALLATION  ⊕  EDITION  ⊕  PLATFORM  ⊕  default
 *
 * `platform_locked` short-circuits: user/org/installation are skipped, so a
 * customer admin can never weaken it — only Daii (edition/platform).
 *
 * `activeEdition` and `orgAncestry` are supplied by the caller so this stays
 * DB-free and unit-testable. In P2 `activeEdition` returns null (no
 * installation table yet — swapped in P3) and `orgAncestry` returns []
 * (ORG/BRANCH deferred — gated by core.config.org_scope_enabled).
 */
export interface ResolveContext {
  userId?: string | null;
  /** The org unit the actor is acting within, plus its ancestors, nearest-first. */
  orgAncestry?: readonly string[];
  /** The installation's active edition code, or null when unknown (P2). */
  activeEdition?: string | null;
}

export interface ResolvedConfig {
  /** The raw stored text (or the key's defaultValue). Coerce separately. */
  raw: string;
  /** Which precedence level supplied it. */
  source: ConfigScopeLevel | 'default';
}

function activeRows(rows: readonly ConfigValue[], key: string): ConfigValue[] {
  return rows.filter((r) => r.key === key && r.archivedAt == null);
}

function pick(rows: ConfigValue[], scopeType: ConfigScopeLevel, scopeId: string | null): string | undefined {
  const hit = rows.find((r) => r.scopeType === scopeType && (r.scopeId ?? null) === (scopeId ?? null));
  return hit?.value;
}

export function resolveConfig(keyMeta: ConfigKey, allValueRows: readonly ConfigValue[], ctx: ResolveContext = {}): ResolvedConfig {
  const rows = activeRows(allValueRows, keyMeta.key);
  const allow = (level: ConfigScopeLevel): boolean => keyMeta.scopeLevels.includes(level);
  const locked = keyMeta.platformLocked;

  // most-specific -> least-specific
  if (!locked && allow('user') && ctx.userId) {
    const v = pick(rows, 'user', ctx.userId);
    if (v !== undefined) return { raw: v, source: 'user' };
  }
  if (!locked && allow('org') && ctx.orgAncestry?.length) {
    for (const orgId of ctx.orgAncestry) {
      const v = pick(rows, 'org', orgId);
      if (v !== undefined) return { raw: v, source: 'org' };
    }
  }
  if (!locked && allow('installation')) {
    const v = pick(rows, 'installation', null);
    if (v !== undefined) return { raw: v, source: 'installation' };
  }
  if (allow('edition') && ctx.activeEdition) {
    const v = pick(rows, 'edition', ctx.activeEdition);
    if (v !== undefined) return { raw: v, source: 'edition' };
  }
  {
    const v = pick(rows, 'platform', null);
    if (v !== undefined) return { raw: v, source: 'platform' };
  }
  return { raw: keyMeta.defaultValue, source: 'default' };
}

/** Which scope levels a customer admin (non-Daii) may write, given the key. P2_BLUEPRINT §8.3. */
export function customerWritableLevels(keyMeta: ConfigKey): ConfigScopeLevel[] {
  const base: ConfigScopeLevel[] = ['user', 'org', 'installation'];
  if (keyMeta.platformLocked) return [];
  return base.filter((l) => keyMeta.scopeLevels.includes(l));
}
