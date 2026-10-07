import { FindOperator } from 'typeorm';
import { NavigationService } from './navigation.service';
import { NAVIGATION_REGISTRY } from './navigation-registry';
import { AuthorizationContext, ContextGrant, ContextRole } from '../authorization/authorization-context';
import { PermissionService } from '../permission/permission.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { RolePermission } from '../permission/role-permission.entity';

/**
 * Authorization Program F1.4 — navigation now consumes the request-scoped AuthorizationContext instead of running one permission query chain per
 * gated item (57 gated items x 3 statements = ~172 statements per `/me/navigation` before F1).
 *
 * Proved here: (1) for 400 random role/grant configurations the context path produces EXACTLY the same navigation as the legacy per-item path
 * (no ability loss, no gain); (2) the context path performs ZERO permission/role queries of its own — the single context load is the whole cost.
 */
const GATED_NODES = [...new Set(NAVIGATION_REGISTRY.flatMap((g) => g.items.map((i) => i.permissionNode).filter((n): n is string => !!n)))];
const ROLE_KEYS = ['admin', 'warehouse_worker', 'warehouse_supervisor', 'inventory_controller', 'driver', 'sales_supervisor', 'sales_manager', 'finance', 'viewer-x'];
const LEVELS = ['hidden', 'read-only', 'editable'] as const;

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function everythingEntitled() {
  const modules = new Set(NAVIGATION_REGISTRY.flatMap((g) => g.items.map((i) => i.module).filter((m): m is string => !!m)));
  const features = new Set(NAVIGATION_REGISTRY.flatMap((g) => g.items.map((i) => i.feature).filter((f): f is string => !!f)));
  return { resolve: () => ({ modules, features }) } as never;
}

describe('Navigation — request-scoped AuthorizationContext (F1.4)', () => {
  it('produces identical navigation to the legacy per-item path for 400 random role/grant configurations, with zero queries of its own', async () => {
    const rnd = lcg(0x5eed);
    for (let iter = 0; iter < 400; iter++) {
      const keys = ROLE_KEYS.filter(() => rnd() < 0.25);
      const roles: ContextRole[] = keys.map((k, i) => ({ id: `r${iter}-${i}`, key: k }));
      // (roleId, nodeKey) is UNIQUE in the real table, so the generator keeps one level per pair
      const unique = new Map<string, ContextGrant>();
      for (const r of roles) {
        for (const node of GATED_NODES) {
          if (rnd() < 0.2) unique.set(r.id + '|' + node, { roleId: r.id, nodeKey: node, access: LEVELS[Math.floor(rnd() * 3)] });
          // module-wide / ancestor grants too (the inheritance path)
          const root = node.split('.')[0];
          if (rnd() < 0.03) unique.set(r.id + '|' + root, { roleId: r.id, nodeKey: root, access: LEVELS[1 + Math.floor(rnd() * 2)] });
        }
      }
      const grants: ContextGrant[] = [...unique.values()];

      let legacyCalls = 0;
      const authorization = {
        getRoleKeysForUser: async () => {
          legacyCalls++;
          return roles.map((r) => r.key);
        },
        getRoleIdsForKeys: async (ks: string[]) => roles.filter((r) => ks.includes(r.key)).map((r) => r.id),
      } as unknown as AuthorizationService;
      const rolePermissionRepo = {
        find: async ({ where }: { where: { roleId: FindOperator<string>; nodeKey: FindOperator<string> } }) => {
          legacyCalls++;
          const ids = new Set(where.roleId.value as unknown as string[]);
          const nodes = new Set(where.nodeKey.value as unknown as string[]);
          return grants.filter((g) => ids.has(g.roleId) && nodes.has(g.nodeKey)) as unknown as RolePermission[];
        },
      };
      const permission = new PermissionService(rolePermissionRepo as never, authorization);
      const service = new NavigationService(everythingEntitled(), permission, authorization);

      const legacy = await service.resolveFor('u');
      const legacyQueries = legacyCalls;
      legacyCalls = 0;
      const ctx = new AuthorizationContext('u', null, roles, grants);
      const viaContext = await service.resolveFor('u', undefined, null, ctx);

      expect(viaContext).toEqual(legacy);
      expect(legacyCalls).toBe(0); // the context path never touched the legacy query chain
      if (roles.length > 0 && iter === 0) expect(legacyQueries).toBeGreaterThan(0);
    }
  });

  it('the registry has the 50+ permission-gated items whose per-item cost (3 statements each) the context removes', () => {
    expect(GATED_NODES.length).toBeGreaterThanOrEqual(40);
    const gatedItems = NAVIGATION_REGISTRY.flatMap((g) => g.items).filter((i) => i.permissionNode).length;
    expect(gatedItems).toBeGreaterThanOrEqual(50);
  });
});
