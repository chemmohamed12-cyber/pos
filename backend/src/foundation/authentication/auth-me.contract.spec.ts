import { DataSource } from 'typeorm';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { AuthMeService, AuthMeView } from './auth-me.service';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { RolePermission } from '../permission/role-permission.entity';
import { permissionCatalogNodes } from '../permission/permission-catalog';

/**
 * Authorization Program F1.2 / F1.6 — `/auth/me` contract (real Postgres, two Companies):
 *  - the new Company-aware fields are correct for the ACTIVE Company and nothing else;
 *  - the legacy fields keep their exact meaning (`roles` = platform/ambient roles) — no breaking removal;
 *  - a forged/unvalidated Company claim yields the platform view, never another Company's data;
 *  - entitlement filters capabilities (Entitlement ≠ Permission);
 *  - `authzVersion` is stable until authority changes;
 *  - frontend `can()` parity: the capability map answers exactly like the server's `hasAtLeast` for every catalog node.
 */
describe('/auth/me — Company-aware contract (F1.2)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let contexts: AuthorizationContextService;
  let me: AuthMeService;
  let U: string;
  let dsA: DataSource;
  let dsB: DataSource;
  let entitledModules: Set<string>;

  async function grantRole(ds: DataSource, userId: string, roleKey: string) {
    const role = await ds.getRepository(Role).findOneOrFail({ where: { key: roleKey } });
    await ds.getRepository(UserRole).save(ds.getRepository(UserRole).create({ userId, roleId: role.id }));
  }

  const request = (companyId?: string, manager?: DataSource['manager']) =>
    ({ user: { id: U, email: 'me-dual@test.local', companyId }, ...(manager ? { companyContext: { companyId, dataSource: { manager } } } : {}) }) as never;

  /** Builds like the controller does: the Company claim is honoured only after Membership re-validation (inside the service). */
  const build = (companyId?: string): Promise<AuthMeView> => me.build(request(companyId));

  /** The rule the frontend's `can()` implements: a lookup of the node's effective level in `capabilities`. */
  const clientCan = (view: AuthMeView, node: string, level: 'read-only' | 'editable') => {
    const rank = { 'read-only': 1, editable: 2 } as const;
    const got = view.capabilities[node];
    return got ? rank[got] >= rank[level] : false;
  };

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'authz_me' });
    const cp = h.controlPlane.options as { host: string; port: number; username: string; password: string; database: string };
    ambient = new DataSource({ type: 'postgres', host: cp.host, port: cp.port, username: cp.username, password: cp.password, database: cp.database, entities: [Role, UserRole, RolePermission], synchronize: false });
    await ambient.initialize();
    contexts = new AuthorizationContextService(ambient);
    entitledModules = new Set(['sales', 'inventory']);
    const companyEntitlement = { resolve: async (companyId: string) => ({ companyId, source: 'package', planCode: 'P', status: 'active', modules: entitledModules, features: new Set<string>() }) };
    const installation = { resolve: () => ({ modules: new Set(['sales']) }) };
    me = new AuthMeService(h.controlPlane, contexts, h.connections, companyEntitlement as never, installation as never);

    dsA = await h.connections.getDataSource(h.companyAId);
    dsB = await h.connections.getDataSource(h.companyBId);
    U = (await h.users.create({ fullName: 'Me Dual User', email: 'me-dual@test.local' })).id;
    await h.memberships.create({ userId: U, companyId: h.companyAId, roleKey: 'sales.manager' });
    await h.memberships.create({ userId: U, companyId: h.companyBId, roleKey: 'sales.viewer' });
    await grantRole(dsA, U, 'sales.manager');
    await grantRole(dsB, U, 'sales.viewer');
    // a PLATFORM (ambient) role that differs from both Company roles: proves legacy `roles` is untouched and the new fields are Company-correct
    let legacy = await ambient.getRepository(Role).findOne({ where: { key: 'sales_rep' } });
    if (!legacy) legacy = await ambient.getRepository(Role).save(ambient.getRepository(Role).create({ key: 'sales_rep' }));
    await ambient.getRepository(UserRole).save(ambient.getRepository(UserRole).create({ userId: U, roleId: legacy.id }));
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('auth-me teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  it('contract shape: every approved field is present (identity, platform, company, membership, capabilities, scopes, entitlements, policyFlags, authzVersion, legacyRoles) and the legacy fields are unchanged', async () => {
    const v = await build(h.companyAId);
    expect(Object.keys(v).sort()).toEqual(
      ['authzVersion', 'capabilities', 'company', 'email', 'entitlements', 'fullName', 'id', 'identity', 'legacy', 'legacyRoles', 'membership', 'platform', 'policyFlags', 'roles', 'scopes'].sort(),
    );
    expect(v).toMatchObject({ id: U, email: 'me-dual@test.local', fullName: 'Me Dual User' });
    expect(v.roles).toEqual(['sales_rep']); // LEGACY meaning preserved: platform/ambient roles
    expect(v.legacyRoles).toEqual(['sales_rep']);
    expect(v.legacy.rolesSource).toBe('platform');
    expect(v.identity).toMatchObject({ id: U, email: 'me-dual@test.local' });
    expect(v.policyFlags.makerChecker).toEqual(['purchase_request', 'purchase_order']);
    expect(typeof v.authzVersion).toBe('string');
  });

  it('Company A: company + membership + Company roles come from A only (not from the platform role)', async () => {
    const v = await build(h.companyAId);
    expect(v.company).toMatchObject({ id: h.companyAId, name: 'Company A', status: 'READY' });
    expect(v.membership?.roleKeys).toEqual(['sales.manager']);
    expect(v.membership?.roles).toEqual([{ key: 'sales.manager', type: 'template', titleCode: 'role.sales.manager' }]);
    expect(v.capabilities['sales.order.create']).toBe('editable');
  });

  it('Company B (same identity): B\'s roles and the read-only capabilities — never A\'s', async () => {
    const v = await build(h.companyBId);
    expect(v.company?.name).toBe('Company B');
    expect(v.membership?.roleKeys).toEqual(['sales.viewer']);
    expect(v.capabilities['sales.order.view']).toBe('read-only');
    expect(v.capabilities['sales.order.create']).toBe('read-only'); // inherited read-only from the module-wide viewer grant — never editable (that is A's level)
    expect(clientCan(v, 'sales.order.create', 'editable')).toBe(false);
    expect(v.roles).toEqual(['sales_rep']); // legacy field is identical in both Companies (platform roles)
  });

  it('forged / unvalidated Company claim: no membership => platform view with NO Company data; a claim for Company A never leaks A through B\'s token', async () => {
    const nonMember = await h.users.create({ fullName: 'Not A Member', email: 'not-member@test.local' });
    const forged = await me.build({ user: { id: nonMember.id, email: 'x', companyId: h.companyAId } } as never);
    expect(forged.company).toBeNull();
    expect(forged.membership).toBeNull();
    expect(forged.capabilities).toEqual({});
    expect(forged.scopes).toMatchObject({ unrestricted: false, orgUnitIds: [] });
    // the member's own view under a claim for a Company they do belong to is that Company's — and only that Company's
    const viaB = await build(h.companyBId);
    expect(viaB.company?.id).toBe(h.companyBId);
  });

  it('platform mode (no Company claim): company/membership are null; capabilities come from the platform tables only', async () => {
    const v = await build(undefined);
    expect(v.company).toBeNull();
    expect(v.membership).toBeNull();
    expect(v.platform.roles).toEqual(['sales_rep']);
    expect(Object.keys(v.capabilities)).not.toContain('sales.order.create'); // the Company grants do not leak into the platform view
  });

  it('entitlement filter (Entitlement ≠ Permission): a module that is not in the Company package yields no capabilities for it, and re-enabling restores them', async () => {
    entitledModules = new Set(['inventory']); // sales NOT entitled
    const off = await build(h.companyAId);
    expect(off.capabilities['sales.order.create']).toBeUndefined();
    expect(off.entitlements.modules).toEqual(['inventory']);
    entitledModules = new Set(['sales', 'inventory']);
    const on = await build(h.companyAId);
    expect(on.capabilities['sales.order.create']).toBe('editable');
    expect(on.entitlements.modules).toEqual(['inventory', 'sales']);
  });

  it('authzVersion is stable while authority is unchanged and changes when the user\'s Company authority changes', async () => {
    const v1 = await build(h.companyBId);
    const v2 = await build(h.companyBId);
    expect(v2.authzVersion).toBe(v1.authzVersion);
    expect((await build(h.companyAId)).authzVersion).not.toBe(v1.authzVersion); // different Company authority
    await grantRole(dsB, U, 'sales.manager'); // B now ALSO grants editable sales
    const v3 = await build(h.companyBId);
    expect(v3.authzVersion).not.toBe(v1.authzVersion);
    expect(v3.membership?.roleKeys.sort()).toEqual(['sales.manager', 'sales.viewer']);
    expect(v3.capabilities['sales.order.create']).toBe('editable');
    const role = await dsB.getRepository(Role).findOneOrFail({ where: { key: 'sales.manager' } });
    await dsB.getRepository(UserRole).delete({ userId: U, roleId: role.id }); // restore B for later assertions
  });

  it('frontend can() parity: for EVERY catalog node and both levels the capability-map lookup equals the server decision (and honours entitlement)', async () => {
    for (const companyId of [h.companyAId, h.companyBId]) {
      const view = await build(companyId);
      const manager = companyId === h.companyAId ? dsA.manager : dsB.manager;
      const ctx = await contexts.forRequest(request(companyId, manager) as never, manager);
      const modules = new Set(view.entitlements.modules);
      const { moduleOfNode } = await import('../permission/permission-catalog');
      let checked = 0;
      let granted = 0;
      for (const node of permissionCatalogNodes()) {
        const mod = moduleOfNode(node);
        const entitled = !mod || modules.has(mod);
        for (const level of ['read-only', 'editable'] as const) {
          const server = ctx.hasAtLeast(node, level) && entitled;
          expect(clientCan(view, node, level)).toBe(server);
          checked++;
          if (server) granted++;
        }
      }
      expect(checked).toBeGreaterThan(300); // the whole catalog, both levels
      expect(granted).toBeGreaterThan(0); // not vacuous
    }
  });
});
