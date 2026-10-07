import { randomUUID } from 'crypto';
import { ConflictException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DataSource } from 'typeorm';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { CORE_COMPANY_ENTITIES } from '../company/core-company-entities';
import { Membership } from '../company/membership.entity';
import { Company } from '../company/company.entity';
import { User } from '../identity/user.entity';
import { MembershipOperation } from '../company/membership-operation.entity';
import { CompanyInvitation } from '../company/company-invitation.entity';
import { MembershipService } from '../company/membership.service';
import { MembershipOperationService } from '../company/membership-operation.service';
import { UsersService } from '../identity/users.service';
import { AuditService } from '../audit/audit.service';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { CompanyContextGuard } from '../company/company-context.guard';
import { CompanyUserManagementService } from '../company/company-user-management.service';
import { CompanyUserError } from '../company/company-user-roles';
import { CompanyRegistryController } from '../company/company-registry.controller';
import { InstallationMembershipController } from '../company/installation-membership.controller';
import { InstallationAuditController } from '../audit/installation-audit.controller';
import { PlansController } from '../plans/plans.controller';
import { EntitlementController } from '../entitlement/entitlement.controller';
import { ConfigurationController } from '../configuration-engine/configuration.controller';
import { LimitController } from '../limit-engine/limit.controller';
import { ReleaseController } from '../release/release.controller';
import { AdminController } from '../admin/admin.controller';
import { PlatformController } from './platform.controller';
import { PlatformGuard, PLATFORM_PERMISSION_KEY } from './platform.guard';
import { PlatformRoleSeeder } from './platform-role.seeder';
import { PLATFORM_NODE_KEYS, PLATFORM_ROLES } from './platform-nodes';
import { SupportAccessService, SUPPORT_ROLE_KEY } from './support-access.service';
import { ROLES_METADATA_KEY } from '../authorization/require-role.decorator';

/**
 * Authorization Foundation F4 — real-Postgres proof for the platform plane:
 *  platform roles seeded in the CONTROL PLANE only · the guard matrix (4 roles + legacy admin + nobody + a Company admin) over real routes · fail-closed ·
 *  legacy-node aliases only where they were the sole gate · completeness of platform route metadata · last-super-admin protection and platform-role escalation ·
 *  support access (reason, ≤ 8 h, platform users only, read-only limited role, expiry enforced by the guard, sweeper, Company-visible audit, Company can end it).
 */
describe('F4 — platform authorization and support access (real Postgres)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let cp: DataSource;
  let contexts: AuthorizationContextService;
  let authorization: AuthorizationService;
  let memberships: MembershipService;
  let users: UsersService;
  let audit: AuditService;
  let support: SupportAccessService;
  let mgmt: CompanyUserManagementService;
  let guard: PlatformGuard;
  let dsA: DataSource;
  const reflector = new Reflector();
  const modules = new Set(['sales', 'inventory']);
  const entitlementFake = { resolve: async () => ({ modules, features: new Set<string>(), source: 'package' }) };

  const U: Record<string, string> = {};
  const mk = async (name: string) => (await users.create({ fullName: name, email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${randomUUID().slice(0, 6)}@f4.test` })).id;
  const give = async (userId: string, roleKey: string) => {
    const [r] = await cp.query(`SELECT id FROM roles WHERE "key" = $1`, [roleKey]);
    await cp.query(`INSERT INTO user_roles ("userId","roleId") VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, r.id]);
  };
  const handlerCtx = (controller: Function, method: string, userId: string, extra: Record<string, unknown> = {}): ExecutionContext =>
    ({
      getHandler: () => (controller.prototype as Record<string, Function>)[method],
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: userId, ...extra } }) }),
    }) as unknown as ExecutionContext;
  const allowed = async (controller: Function, method: string, userId: string, extra: Record<string, unknown> = {}) => {
    try {
      return await guard.canActivate(handlerCtx(controller, method, userId, extra));
    } catch (e) {
      if (e instanceof ForbiddenException) return false;
      throw e;
    }
  };
  const expectCode = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toMatchObject({ code });
  };

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'f4_platform', roleModuleCodes: ['sales', 'inventory'] });
    const o = h.controlPlane.options as { host: string; port: number; username: string; password: string; database: string };
    cp = new DataSource({ type: 'postgres', host: o.host, port: o.port, username: o.username, password: o.password, database: o.database, entities: [...CORE_COMPANY_ENTITIES, Membership, Company, User, MembershipOperation, CompanyInvitation], synchronize: false });
    await cp.initialize();
    memberships = new MembershipService(cp.getRepository(Membership));
    users = new UsersService(cp.getRepository(User));
    audit = new AuditService(cp);
    contexts = new AuthorizationContextService(cp);
    authorization = new AuthorizationService(cp.getRepository(Role), cp.getRepository(UserRole));
    guard = new PlatformGuard(reflector, contexts);
    mgmt = new CompanyUserManagementService(memberships, new MembershipOperationService(cp.getRepository(MembershipOperation)), users, audit);
    support = new SupportAccessService(memberships, h.companies, h.connections, users, audit, contexts, entitlementFake as never, cp);
    dsA = await h.connections.getDataSource(h.companyAId);

    // the legacy ambient admin exists first (as in every real installation); the seeder then adds the four platform roles and gives admin the platform nodes
    await cp.query(`INSERT INTO roles ("key","type") VALUES ('admin','legacy') ON CONFLICT DO NOTHING`);
    const seed = await new PlatformRoleSeeder(cp).seed();
    expect(seed.roles).toBe(4);
    for (const k of ['legacyAdmin', 'superAdmin', 'companyManager', 'support', 'auditor', 'nobody', 'companyAdmin', 'outsider']) U[k] = await mk(k);
    await give(U.legacyAdmin, 'admin');
    await give(U.superAdmin, 'platform_super_admin');
    await give(U.companyManager, 'company_manager');
    await give(U.support, 'support_operations');
    await give(U.auditor, 'platform_audit_readonly');
    // a Company administrator (Company DB admin role + membership) with NO platform role
    U.companyAdmin = (await h.createUserWithAdminRoleIn('F4 Company Admin', h.companyAId)).id;
  });

  afterAll(async () => {
    if (cp?.isInitialized) await cp.destroy();
    await h.teardown().catch((e) => console.warn('f4 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  it('platform roles live in the CONTROL PLANE only (never in a Company catalog); the seed is idempotent and additive; admin gains every platform node', async () => {
    expect((await cp.query(`SELECT count(*)::int n FROM roles WHERE "key" = ANY($1::text[])`, [PLATFORM_ROLES.map((r) => r.key)]))[0].n).toBe(4);
    expect((await dsA.query(`SELECT count(*)::int n FROM roles WHERE "key" = ANY($1::text[])`, [PLATFORM_ROLES.map((r) => r.key)]))[0].n).toBe(0);
    const again = await new PlatformRoleSeeder(cp).seed();
    expect(again).toEqual({ roles: 0, grants: 0 });
    const adminGrants = (await cp.query(`SELECT rp."nodeKey" n FROM role_permissions rp JOIN roles r ON r.id=rp."roleId" WHERE r."key"='admin' AND rp."nodeKey" LIKE 'platform.%'`)).map((r: { n: string }) => r.n);
    expect(adminGrants.sort()).toEqual([...PLATFORM_NODE_KEYS].sort());
    const sa = await contexts.load(U.superAdmin, null);
    for (const n of PLATFORM_NODE_KEYS) expect(sa.hasAtLeast(n, n.endsWith('.view') ? 'read-only' : 'editable')).toBe(true);
  });

  it('guard matrix over the real routes: each platform role may do exactly its capabilities; nobody and a Company administrator get nothing (two planes)', async () => {
    const routes: Array<[string, Function, string]> = [
      ['company.view', CompanyRegistryController, 'list'],
      ['company.create', CompanyRegistryController, 'create'],
      ['company.suspend', CompanyRegistryController, 'suspend'],
      ['company.decommission', CompanyRegistryController, 'decommission'],
      ['membership.view', InstallationMembershipController, 'list'],
      ['membership.grant', InstallationMembershipController, 'grant'],
      ['audit.view', InstallationAuditController, 'list'],
      ['plan.view', PlansController, 'list'],
      ['plan.manage', PlansController, 'create'],
      ['entitlement.manage', PlansController, 'assignPackage'],
      ['release.deploy', ReleaseController, 'deployRelease'],
      ['user.reset_password', AdminController, 'resetPassword'],
      ['support.grant', PlatformController, 'grant'],
      ['support.view', PlatformController, 'listSupport'],
    ];
    const expectation: Record<string, string[]> = {
      legacyAdmin: routes.map((r) => r[0]),
      superAdmin: routes.map((r) => r[0]),
      companyManager: ['company.view', 'company.create', 'company.suspend', 'membership.view', 'membership.grant', 'audit.view', 'plan.view', 'entitlement.manage', 'support.grant', 'support.view'],
      support: ['company.view', 'membership.view', 'audit.view', 'plan.view', 'support.grant', 'support.view'],
      auditor: ['company.view', 'membership.view', 'audit.view', 'plan.view', 'support.view'],
      nobody: [],
      companyAdmin: [],
    };
    for (const [who, expected] of Object.entries(expectation)) {
      for (const [label, ctrl, method] of routes) {
        // a Company-scoped token (companyId claim) changes nothing: the platform guard reads ambient authority only
        const got = await allowed(ctrl, method, U[who], who === 'companyAdmin' ? { companyId: h.companyAId } : {});
        expect({ who, label, got }).toEqual({ who, label, got: expected.includes(label) });
      }
    }
  });

  it('fail-closed and legacy aliases: an undeclared platform route is denied for everyone (even the legacy admin); a legacy node is honoured only where it was the sole gate', async () => {
    class Undeclared {
      handler() {}
    }
    await expect(guard.canActivate(handlerCtx(Undeclared, 'handler', U.legacyAdmin))).rejects.toBeInstanceOf(ForbiddenException);
    // config / limits / entitlement kept their legacy node as a route-level alias (it WAS the sole gate); release required admin AND the node, so it must NOT loosen
    const legacyOnly = await mk('legacyConfigEditor');
    const [cr] = await cp.query(`INSERT INTO roles ("key","type") VALUES ('legacy_config_editor','custom') RETURNING id`);
    for (const n of ['core.config.edit', 'core.config.view', 'system.release.deploy']) await cp.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable')`, [cr.id, n]);
    await cp.query(`INSERT INTO user_roles ("userId","roleId") VALUES ($1,$2)`, [legacyOnly, cr.id]);
    expect(await allowed(ConfigurationController, 'setValue', legacyOnly)).toBe(true); // legacy node alias honoured (sole gate before F4)
    expect(await allowed(ConfigurationController, 'listKeys', legacyOnly)).toBe(true);
    expect(await allowed(ReleaseController, 'deployRelease', legacyOnly)).toBe(false); // release needed admin AND the node: no loosening
    expect(await allowed(LimitController, 'setProfile', legacyOnly)).toBe(false); // limits node not held
    expect(await allowed(EntitlementController, 'adminView', legacyOnly)).toBe(false);
  });

  it('completeness: EVERY route of every platform controller declares a platform permission (or its explicit legacy role fallback) — nothing is left to the fail-closed default', () => {
    const controllers: Function[] = [CompanyRegistryController, InstallationMembershipController, InstallationAuditController, PlansController, ConfigurationController, LimitController, ReleaseController, AdminController, PlatformController, EntitlementController];
    const unguarded: string[] = [];
    let total = 0;
    for (const c of controllers) {
      for (const name of Object.getOwnPropertyNames(c.prototype)) {
        const fn = (c.prototype as Record<string, Function>)[name];
        if (name === 'constructor' || typeof fn !== 'function' || Reflect.getMetadata(PATH_METADATA, fn) === undefined) continue;
        total++;
        const platform = reflector.getAllAndOverride(PLATFORM_PERMISSION_KEY, [fn, c]);
        const roles = reflector.getAllAndOverride(ROLES_METADATA_KEY, [fn, c]);
        const guards: unknown[] = [...(Reflect.getMetadata('__guards__', c) ?? []), ...(Reflect.getMetadata('__guards__', fn) ?? [])];
        const usesPlatformGuard = guards.includes(PlatformGuard);
        if (usesPlatformGuard && !platform && !(roles && roles.length)) unguarded.push(`${c.name}.${name}`);
      }
    }
    expect(total).toBeGreaterThan(60);
    expect(unguarded).toEqual([]);
    // `me/entitlements` is the one deliberately open (JWT-only) route of the entitlement controller
    expect(reflector.getAllAndOverride(PLATFORM_PERMISSION_KEY, [EntitlementController.prototype.meEntitlements, EntitlementController])).toBeUndefined();
  });

  it('platform roles: assigning/revoking a PLATFORM role needs platform.role.manage; the last Super Admin cannot be removed; every write is audited (AZ-07)', async () => {
    const fake = { users: { findById: (id: string) => users.findById(id), setStatus: async () => ({}) } };
    const admin = new AdminController(authorization, fake.users as never, null as never, audit, contexts);
    const req = (id: string) => ({ user: { id } }) as never;
    const target = await mk('roleTarget');
    await expect(admin.assignRole(req(U.companyManager), { userId: target, roleKey: 'platform_super_admin' })).rejects.toBeInstanceOf(ForbiddenException); // escalation blocked
    await admin.assignRole(req(U.superAdmin), { userId: target, roleKey: 'support_operations' });
    expect(await authorization.getRoleKeysForUser(target)).toEqual(['support_operations']);
    await admin.revokeRole(req(U.superAdmin), { userId: target, roleKey: 'support_operations' });
    // last super admin: legacy admin + platform_super_admin are two holders; removing one is fine, removing the last is refused
    await admin.revokeRole(req(U.superAdmin), { userId: U.legacyAdmin, roleKey: 'admin' });
    await expect(admin.revokeRole(req(U.superAdmin), { userId: U.superAdmin, roleKey: 'platform_super_admin' })).rejects.toBeInstanceOf(ConflictException);
    await give(U.legacyAdmin, 'admin'); // restore
    const audited = await cp.query(`SELECT action FROM audit_records WHERE action LIKE 'platform.role.%' ORDER BY seq`);
    expect(audited.map((r: { action: string }) => r.action)).toEqual(['platform.role.assigned', 'platform.role.revoked', 'platform.role.revoked']);
    expect((await audit.verifyChain()).valid).toBe(true);
  });

  describe('support access', () => {
    let supportUser: string;
    beforeAll(async () => {
      supportUser = U.support;
    });

    it('validation: reason ≥ 10 chars, ≤ 8 hours, platform users only, not for an ordinary member; the role is fixed and read-only', async () => {
      const base = { companyId: h.companyAId, reason: 'Investigating invoice posting issue #4411' };
      await expectCode(support.grant(U.support, { ...base, reason: 'short' }), 'INVALID_INPUT');
      await expectCode(support.grant(U.support, { ...base, hours: 9 }), 'INVALID_INPUT');
      await expectCode(support.grant(U.support, { ...base, hours: 0 }), 'INVALID_INPUT');
      await expectCode(support.grant(U.support, { ...base, userId: U.nobody }), 'INVALID_INPUT'); // not a platform user
      await expectCode(support.grant(U.support, { ...base, userId: U.companyAdmin }), 'INVALID_INPUT'); // a Company admin is not a platform user either
      await h.memberships.create({ userId: U.auditor, companyId: h.companyAId, roleKey: 'admin' });
      await expectCode(support.grant(U.support, { ...base, userId: U.auditor }), 'ALREADY_MEMBER'); // regular member: no support access on top
      await h.memberships.revoke(U.auditor, h.companyAId);
    });

    it('grant: explicit, reason-required, time-boxed membership with ONE limited read-only role; visible to the Company (directory + its own audit chain); the platform chain records it too', async () => {
      const v = await support.grant(U.companyManager, { companyId: h.companyAId, userId: supportUser, reason: 'Investigating invoice posting issue #4411', hours: 2 });
      expect(v).toMatchObject({ companyId: h.companyAId, userId: supportUser, roleKey: SUPPORT_ROLE_KEY, grantedBy: U.companyManager });
      expect(new Date(v.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(2 * 3_600_000 + 5_000);
      const m = (await memberships.findByUserAndCompany(supportUser, h.companyAId))!;
      expect(m).toMatchObject({ kind: 'support', status: 'active', roleKey: SUPPORT_ROLE_KEY, reason: 'Investigating invoice posting issue #4411' });
      // authority: read-only on the entitled modules, nothing editable, nothing critical, no administration
      const ctx = await contexts.load(supportUser, h.companyAId, dsA.manager);
      expect(ctx.roleKeys).toEqual([SUPPORT_ROLE_KEY]);
      expect(ctx.hasAtLeast('sales.order.view', 'read-only')).toBe(true);
      expect(ctx.hasAtLeast('sales.order.create', 'editable')).toBe(false);
      expect(ctx.hasAtLeast('core.company.members.manage', 'read-only')).toBe(false);
      expect(ctx.hasAtLeast('accounting.journal.view', 'read-only')).toBe(false); // not entitled
      // Company visibility
      const dir = (await mgmt.directory(h.companyAId, dsA)).find((r) => r.userId === supportUser)!;
      expect(dir.membership).toMatchObject({ kind: 'support', reason: 'Investigating invoice posting issue #4411' });
      expect(dir.membership.expiresAt).toBe(v.expiresAt);
      expect((await dsA.query(`SELECT after FROM audit_records WHERE action = 'support_access.granted'`))[0].after.reason).toBe('Investigating invoice posting issue #4411');
      expect((await cp.query(`SELECT 1 FROM audit_records WHERE action = 'platform.support_access.granted'`)).length).toBe(1);
      // the Company cannot silently turn it into a normal membership
      const A = { userId: U.companyAdmin, authz: await contexts.load(U.companyAdmin, null, dsA.manager) };
      await expectCode(mgmt.setRoles(A, h.companyAId, dsA, supportUser, ['sales.manager']), 'SUPPORT_ACCESS_FIXED');
      await expectCode(mgmt.setStatus(A, h.companyAId, dsA, supportUser, 'suspended'), 'SUPPORT_ACCESS_FIXED');
      // only Company A: Company B never sees the access
      expect(await memberships.findActiveByUserAndCompany(supportUser, h.companyBId)).toBeNull();
      expect((await mgmt.directory(h.companyBId, await h.connections.getDataSource(h.companyBId))).some((r) => r.userId === supportUser)).toBe(false);
    });

    it('no standing back door: platform authority alone gives no Company access; the access guard enforces the expiry on the very next request; the sweeper closes it and audits it in both chains', async () => {
      const g = new CompanyContextGuard(memberships, h.companies, h.connections);
      const call = (userId: string) => g.canActivate({ switchToHttp: () => ({ getRequest: () => ({ user: { id: userId, companyId: h.companyAId } }) }) } as never);
      await expect(call(supportUser)).resolves.toBe(true);
      await expect(call(U.superAdmin)).rejects.toBeInstanceOf(ForbiddenException); // a Super Admin without a membership gets nothing
      await cp.query(`UPDATE user_company_memberships SET "expiresAt" = now() - interval '1 minute' WHERE "userId" = $1 AND "companyId" = $2`, [supportUser, h.companyAId]);
      await expect(call(supportUser)).rejects.toBeInstanceOf(ForbiddenException); // expired = refused immediately, before any sweep
      expect(await support.expireDue()).toBe(1);
      expect(await memberships.findByUserAndCompany(supportUser, h.companyAId)).toBeNull();
      expect((await dsA.query(`SELECT count(*)::int n FROM user_roles WHERE "userId" = $1`, [supportUser]))[0].n).toBe(0);
      expect((await dsA.query(`SELECT 1 FROM audit_records WHERE action = 'support_access.expired'`)).length).toBe(1);
      expect((await cp.query(`SELECT 1 FROM audit_records WHERE action = 'platform.support_access.expired'`)).length).toBe(1);
      expect(await support.expireDue()).toBe(0); // idempotent
    });

    it('re-grant extends; the Company can end the access at any time (audited in its own chain); a platform user can revoke it too; chains verify', async () => {
      await support.grant(U.support, { companyId: h.companyAId, reason: 'Second investigation window for ticket 4412', hours: 1 });
      const first = (await memberships.findByUserAndCompany(supportUser, h.companyAId))!.expiresAt!.getTime();
      await support.grant(U.companyManager, { companyId: h.companyAId, userId: supportUser, reason: 'Extended after the customer asked', hours: 3 });
      const second = (await memberships.findByUserAndCompany(supportUser, h.companyAId))!;
      expect(second.expiresAt!.getTime()).toBeGreaterThan(first);
      expect(second.reason).toBe('Extended after the customer asked');
      // the Company administrator ends it
      const A = { userId: U.companyAdmin, authz: await contexts.load(U.companyAdmin, null, dsA.manager) };
      await mgmt.removeMember(A, h.companyAId, dsA, supportUser);
      expect(await memberships.findByUserAndCompany(supportUser, h.companyAId)).toBeNull();
      expect((await dsA.query(`SELECT 1 FROM audit_records WHERE action = 'support_access.revoked'`)).length).toBe(1);
      // platform revoke path
      await support.grant(U.support, { companyId: h.companyAId, reason: 'One more short window to confirm the fix', hours: 1 });
      await support.revoke(U.support, h.companyAId, supportUser, 'platform');
      expect(await memberships.findByUserAndCompany(supportUser, h.companyAId)).toBeNull();
      await expectCode(support.revoke(U.support, h.companyAId, supportUser, 'platform'), 'NOT_A_MEMBER');
      expect(await support.list(h.companyAId)).toEqual([]);
      expect((await audit.verifyCompanyChain(dsA.manager)).valid).toBe(true);
      expect((await audit.verifyChain()).valid).toBe(true);
    });
  });
});
