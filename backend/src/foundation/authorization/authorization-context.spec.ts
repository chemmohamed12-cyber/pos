import { FindOperator } from 'typeorm';
import { AuthorizationContext, ancestorChain, ContextGrant, ContextRole } from './authorization-context';
import { PermissionService } from '../permission/permission.service';
import { AuthorizationService } from './authorization.service';
import { PermissionAccess, RolePermission } from '../permission/role-permission.entity';
import { AuthorizationContextService } from './authorization-context.service';

/**
 * Authorization Program F1.1 — the request-scoped AuthorizationContext must make EXACTLY the decisions `PermissionService.resolve` makes (ADR-005):
 * deny by default, most-specific ancestor per role, most permissive across roles, no deny grants. Property test over many random role/grant
 * configurations: every node in a fixed pool resolves identically through both implementations.
 */
const POOL = ['a', 'a.b', 'a.b.c', 'a.b.d', 'a.e', 'a.e.f', 'x', 'x.y', 'x.y.z', 'q'];
const LEVELS: PermissionAccess[] = ['hidden', 'read-only', 'editable'];

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function legacyService(roles: ContextRole[], grants: ContextGrant[]): PermissionService {
  const authorization = {
    getRoleKeysForUser: async () => roles.map((r) => r.key),
    getRoleIdsForKeys: async (keys: string[]) => roles.filter((r) => keys.includes(r.key)).map((r) => r.id),
  } as unknown as AuthorizationService;
  const rolePermissionRepo = {
    find: async ({ where }: { where: { roleId: FindOperator<string>; nodeKey: FindOperator<string> } }) => {
      const roleIds = new Set(where.roleId.value as unknown as string[]);
      const nodeKeys = new Set(where.nodeKey.value as unknown as string[]);
      return grants.filter((g) => roleIds.has(g.roleId) && nodeKeys.has(g.nodeKey)) as unknown as RolePermission[];
    },
  };
  return new PermissionService(rolePermissionRepo as never, authorization);
}

describe('AuthorizationContext — decision parity with PermissionService (property test)', () => {
  it('resolves every pooled node identically for 600 random role/grant configurations', async () => {
    const rnd = lcg(20261006);
    let mismatches = 0;
    let nonTrivial = 0;
    for (let iter = 0; iter < 600; iter++) {
      const roleCount = Math.floor(rnd() * 4); // 0..3 roles (0 = no role at all)
      const roles: ContextRole[] = Array.from({ length: roleCount }, (_, i) => ({ id: `role-${iter}-${i}`, key: `r${i}` }));
      const grants: ContextGrant[] = [];
      for (const r of roles) {
        for (const node of POOL) {
          if (rnd() < 0.3) grants.push({ roleId: r.id, nodeKey: node, access: LEVELS[Math.floor(rnd() * 3)] });
        }
      }
      const ctx = new AuthorizationContext('u', 'c', roles, grants);
      const svc = legacyService(roles, grants);
      for (const node of POOL) {
        const expected = await svc.resolve('u', node);
        const actual = ctx.resolve(node);
        if (expected !== actual) mismatches++;
        if (expected !== 'hidden') nonTrivial++;
        for (const need of ['read-only', 'editable'] as const) {
          if ((await svc.hasAtLeast('u', node, need)) !== ctx.hasAtLeast(node, need)) mismatches++;
        }
      }
    }
    expect(mismatches).toBe(0);
    expect(nonTrivial).toBeGreaterThan(500); // the generator actually exercised grants, not just "hidden"
  });

  it('documented semantics: deny by default; a role\'s most-specific grant shadows its own broader grant; roles are additive (most permissive wins)', () => {
    const roleA: ContextRole = { id: 'A', key: 'a-role' };
    const roleB: ContextRole = { id: 'B', key: 'b-role' };
    // role A: editable on the module but read-only on the journal (specific shadows broader FOR THIS ROLE)
    // role B: editable on the journal
    const grants: ContextGrant[] = [
      { roleId: 'A', nodeKey: 'accounting', access: 'editable' },
      { roleId: 'A', nodeKey: 'accounting.journal', access: 'read-only' },
      { roleId: 'B', nodeKey: 'accounting.journal', access: 'editable' },
    ];
    const onlyA = new AuthorizationContext('u', 'c', [roleA], grants);
    expect(onlyA.resolve('accounting.journal.post')).toBe('read-only'); // the specific read-only shadows A's own module-wide editable
    expect(onlyA.resolve('accounting.account.edit')).toBe('editable'); // no specific row => the module-wide grant applies
    expect(onlyA.resolve('sales.order.create')).toBe('hidden'); // deny by default
    const both = new AuthorizationContext('u', 'c', [roleA, roleB], grants);
    expect(both.resolve('accounting.journal.post')).toBe('editable'); // union: B's editable wins
    const none = new AuthorizationContext('u', 'c', [], grants);
    expect(none.resolve('accounting.journal.post')).toBe('hidden'); // no roles => nothing, even though grant rows exist
    expect(ancestorChain('a.b.c')).toEqual(['a.b.c', 'a.b', 'a']);
  });

  it('effectiveFor omits hidden nodes and reports the effective level (the data behind /auth/me.capabilities)', () => {
    const roles: ContextRole[] = [{ id: 'A', key: 'r' }];
    const ctx = new AuthorizationContext('u', 'c', roles, [{ roleId: 'A', nodeKey: 'a.b', access: 'read-only' }, { roleId: 'A', nodeKey: 'x', access: 'editable' }]);
    expect(ctx.effectiveFor(['a', 'a.b', 'a.b.c', 'x.y', 'q'])).toEqual({ 'a.b': 'read-only', 'a.b.c': 'read-only', 'x.y': 'editable' });
    expect(ctx.roleKeys).toEqual(['r']);
    expect(ctx.hasRole('r')).toBe(true);
    expect(ctx.hasRole('other')).toBe(false);
  });
});

describe('AuthorizationContextService — request memoization is per request object and never caches a failure', () => {
  /** A manager whose single `query` returns the joined roles x grants rows (the one statement the service issues). */
  function fakeDataSource(roleRows: Array<{ id: string; key: string }>, grants: ContextGrant[], counter: { n: number }) {
    return {
      query: async () => {
        counter.n++;
        const rows: Array<{ roleId: string; key: string; nodeKey: string | null; access: string | null }> = [];
        for (const r of roleRows) {
          const mine = grants.filter((g) => g.roleId === r.id);
          if (mine.length === 0) rows.push({ roleId: r.id, key: r.key, nodeKey: null, access: null });
          for (const g of mine) rows.push({ roleId: r.id, key: r.key, nodeKey: g.nodeKey, access: g.access });
        }
        return rows;
      },
    } as never;
  }

  it('loads once per request (ONE statement) no matter how many times it is consulted', async () => {
    const counter = { n: 0 };
    const ds = fakeDataSource([{ id: 'R', key: 'k' }], [{ roleId: 'R', nodeKey: 'a', access: 'editable' }], counter);
    const svc = new AuthorizationContextService(ds);
    const req = { user: { id: 'u', companyId: 'c' }, companyContext: { companyId: 'c', dataSource: { manager: ds } } };
    const a = await svc.forRequest(req as never);
    const b = await svc.forRequest(req as never);
    const c = await svc.forRequest(req as never);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(counter.n).toBe(1); // roles x grants, one statement, once
    // a DIFFERENT request object never shares it (no cross-request cache => a role change applies on the next request)
    const req2 = { user: { id: 'u', companyId: 'c' }, companyContext: { companyId: 'c', dataSource: { manager: ds } } };
    await svc.forRequest(req2 as never);
    expect(counter.n).toBe(2);
  });

  it('a failed load rejects (fail closed) and is NOT cached — the next call retries', async () => {
    let fail = true;
    const counter = { n: 0 };
    const good = fakeDataSource([{ id: 'R', key: 'k' }], [], counter);
    const manager = {
      query: (...args: unknown[]) => {
        if (fail) throw new Error('db down');
        return (good as unknown as { query: (...a: unknown[]) => unknown }).query(...args);
      },
    };
    const svc = new AuthorizationContextService(manager as never);
    const req = { user: { id: 'u' }, companyContext: { companyId: 'c', dataSource: { manager } } };
    await expect(svc.forRequest(req as never)).rejects.toThrow('db down');
    fail = false;
    const ctx = await svc.forRequest(req as never);
    expect(ctx.roleKeys).toEqual(['k']);
  });

  it('rejects when the request is not authenticated', async () => {
    const svc = new AuthorizationContextService({} as never);
    await expect(svc.forRequest({} as never)).rejects.toThrow('authenticated');
  });
});
