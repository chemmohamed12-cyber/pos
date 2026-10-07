import { createHash } from 'crypto';
import { PermissionAccess } from '../permission/role-permission.entity';

/**
 * Authorization Program F1.1 — the request-scoped AuthorizationContext (Blueprint §12/§22).
 *
 * A PURE value object: the roles one user holds in one authorization domain (a Company database, or the ambient/platform tables) and every
 * `role_permissions` row of those roles, loaded ONCE per request by `AuthorizationContextService`. Every consumer on the request — `RolesGuard`,
 * `PermissionGuard`, navigation, `/auth/me` — then asks this object instead of re-querying (the pre-F1 cost was 3 statements per node check:
 * 57 gated navigation items = ~172 statements per `/me/navigation`).
 *
 * Semantics are IDENTICAL to `PermissionService.resolve` (ADR-005): for each role walk the node's ancestor chain most-specific-first and take the
 * first configured level; across roles take the most permissive; nothing configured = `hidden` (deny by default). There is no deny grant.
 */
const ACCESS_RANK: Record<PermissionAccess, number> = { hidden: 0, 'read-only': 1, editable: 2 };

/** All ancestor keys of a dotted path, most-specific first: "a.b.c" -> ["a.b.c", "a.b", "a"]. Same function as `PermissionService`. */
export function ancestorChain(nodeKey: string): string[] {
  const parts = nodeKey.split('.');
  const chain: string[] = [];
  for (let i = parts.length; i > 0; i--) chain.push(parts.slice(0, i).join('.'));
  return chain;
}

export interface ContextRole {
  id: string;
  key: string;
}
export interface ContextGrant {
  roleId: string;
  nodeKey: string;
  access: PermissionAccess;
}

export class AuthorizationContext {
  /** roleId -> (nodeKey -> access) */
  private readonly grantsByRole = new Map<string, Map<string, PermissionAccess>>();
  private readonly memo = new Map<string, PermissionAccess>();

  constructor(
    readonly userId: string,
    /** The Company this context was resolved for; `null` = platform (ambient) tables. Informational — it was fixed when the data was loaded. */
    readonly companyId: string | null,
    readonly roles: readonly ContextRole[],
    grants: readonly ContextGrant[],
  ) {
    for (const g of grants) {
      let m = this.grantsByRole.get(g.roleId);
      if (!m) this.grantsByRole.set(g.roleId, (m = new Map()));
      m.set(g.nodeKey, g.access);
    }
  }

  /** A digest of exactly what was loaded (role ids + every grant), used as the cache key for derived/computed views. Order-independent. */
  signature(): string {
    if (this.sig) return this.sig;
    const parts: string[] = this.roles.map((r) => r.id + ':' + r.key).sort();
    const rows: string[] = [];
    for (const [roleId, m] of this.grantsByRole) for (const [node, level] of m) rows.push(roleId + '|' + node + '|' + level);
    rows.sort();
    this.sig = createHash('sha1').update(parts.join(',') + '#' + rows.join(',')).digest('hex');
    return this.sig;
  }
  private sig: string | null = null;

  get roleKeys(): string[] {
    return this.roles.map((r) => r.key);
  }

  hasRole(roleKey: string): boolean {
    return this.roles.some((r) => r.key === roleKey);
  }

  /** The effective access level for a node. Deny by default; most-specific per role, most permissive across roles. */
  resolve(nodeKey: string): PermissionAccess {
    const cached = this.memo.get(nodeKey);
    if (cached) return cached;
    let best: PermissionAccess = 'hidden';
    if (this.roles.length > 0) {
      const chain = ancestorChain(nodeKey);
      for (const role of this.roles) {
        const grants = this.grantsByRole.get(role.id);
        if (!grants) continue;
        for (const key of chain) {
          const level = grants.get(key);
          if (level) {
            if (ACCESS_RANK[level] > ACCESS_RANK[best]) best = level;
            break; // most-specific ancestor found for this role
          }
        }
      }
    }
    this.memo.set(nodeKey, best);
    return best;
  }

  hasAtLeast(nodeKey: string, required: PermissionAccess): boolean {
    return ACCESS_RANK[this.resolve(nodeKey)] >= ACCESS_RANK[required];
  }

  /** Effective level for every node in `nodeKeys`, omitting `hidden` — the data behind `/auth/me.capabilities` (a UX hint, never an authority). */
  effectiveFor(nodeKeys: Iterable<string>): Record<string, Exclude<PermissionAccess, 'hidden'>> {
    const out: Record<string, Exclude<PermissionAccess, 'hidden'>> = {};
    for (const n of nodeKeys) {
      const level = this.resolve(n);
      if (level !== 'hidden') out[n] = level;
    }
    return out;
  }
}
