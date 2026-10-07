/**
 * Authorization Program F1.3 — the frontend authorization ABSTRACTION: `can()` and `inScope()`.
 *
 * Frontend = UX guidance, Backend = final authority (Zero Trust, amendment A6). `GET /auth/me` returns the effective node -> level map the backend
 * already resolved for the CURRENT Company (entitlement-filtered); `can()` is a pure lookup in it. It decides what to SHOW or ENABLE — it never
 * grants anything: every protected operation is re-verified by the server, which ignores whatever the client believes.
 *
 * Parity rule (tested in the backend suite): for every catalog node, `can(node, level)` is true exactly when the server's `hasAtLeast(node, level)`
 * is true for that user in that Company.
 */
export type AccessLevel = 'read-only' | 'editable';

export interface AuthzView {
  identity: { id: string; email: string; fullName: string; status: string };
  platform: { roles: string[]; capabilities: Record<string, AccessLevel>; isPlatformAdmin: boolean };
  company: { id: string; name: string; status: string } | null;
  membership: { id: string; roleKeys: string[]; roles: Array<{ key: string; type: string; titleCode: string | null }>; joinedAt: string } | null;
  capabilities: Record<string, AccessLevel>;
  scopes: { unrestricted: boolean; orgUnitIds: string[]; warehouseIds: string[]; departmentIds: string[]; ownOnly: boolean };
  entitlements: { modules: string[]; source: string | null };
  policyFlags: { makerChecker: string[] };
  authzVersion: string;
  legacyRoles: string[];
}

const RANK: Record<string, number> = { hidden: 0, 'read-only': 1, editable: 2 };

/** True when the resolved level for `node` is at least `level`. Unknown/unloaded -> false (deny-by-default UX). */
export function canFrom(authz: AuthzView | null, node: string, level: AccessLevel = 'read-only'): boolean {
  if (!authz) return false;
  return (RANK[authz.capabilities[node] ?? 'hidden'] ?? 0) >= RANK[level];
}

export type ScopeKind = 'orgUnit' | 'warehouse' | 'department';

/** True when the user's scope covers the given unit: unrestricted, or the id is in their granted set. A hint only — services enforce scope server-side. */
export function inScopeFrom(authz: AuthzView | null, kind: ScopeKind, id: string): boolean {
  if (!authz) return false;
  if (authz.scopes.unrestricted) return true;
  const set = kind === 'orgUnit' ? authz.scopes.orgUnitIds : kind === 'warehouse' ? authz.scopes.warehouseIds : authz.scopes.departmentIds;
  return set.includes(id);
}
