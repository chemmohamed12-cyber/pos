import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { AuthorizationContextService } from './authorization-context.service';
import { AuthorizationService } from './authorization.service';
import { PermissionGuard } from '../permission/permission.guard';
import { PermissionService } from '../permission/permission.service';
import { RolePermission } from '../permission/role-permission.entity';
import { RolesGuard } from './roles.guard';
import { Role } from './role.entity';
import { UserRole } from './user-role.entity';
import { RequirePermission } from '../permission/require-permission.decorator';
import { RequireRole } from './require-role.decorator';
import { CompanyScopedRequest } from '../company/company-context.guard';

/**
 * Authorization Program F1.1 / F1.6 — real-Postgres proof (two Companies) that the request-scoped AuthorizationContext
 *  - resolves a user's authority from the ACTIVE Company's own tables only (same identity, different roles per Company),
 *  - is loaded once per request (2 statements) however many guards/consumers ask,
 *  - fails closed and never caches a failure,
 *  - never leaks across requests (a role revoked between two requests applies to the second),
 *  - ignores forged authorization input on the request (roles/capabilities/company claims/headers/body).
 */
describe('AuthorizationContext — real-Postgres Company isolation, request scope, fail-closed (F1)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let contexts: AuthorizationContextService;
  let permissionGuard: PermissionGuard;
  let rolesGuard: RolesGuard;
  let legacyPermissionGuard: PermissionGuard;
  let U: string; // one identity, two Companies, different roles
  let dsA: DataSource;
  let dsB: DataSource;

  const reflector = new Reflector();

  class Sample {
    @RequirePermission('sales.order.create', 'editable')
    create() {}
    @RequirePermission('sales.order.view', 'read-only')
    view() {}
    @RequireRole('sales.manager')
    managerOnly() {}
  }
  const ctxFor = (request: unknown, method: keyof Sample): ExecutionContext =>
    ({
      getHandler: () => Sample.prototype[method],
      getClass: () => Sample,
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  const reqFor = (companyId: string, manager: unknown, extra: Record<string, unknown> = {}): CompanyScopedRequest =>
    ({ user: { id: U, email: 'u@test.local', companyId }, companyContext: { companyId, dataSource: { manager } }, ...extra }) as unknown as CompanyScopedRequest;

  async function grantRole(ds: DataSource, userId: string, roleKey: string) {
    const role = await ds.getRepository(Role).findOneOrFail({ where: { key: roleKey } });
    await ds.getRepository(UserRole).save(ds.getRepository(UserRole).create({ userId, roleId: role.id }));
  }
  async function revokeRole(ds: DataSource, userId: string, roleKey: string) {
    const role = await ds.getRepository(Role).findOneOrFail({ where: { key: roleKey } });
    await ds.getRepository(UserRole).delete({ userId, roleId: role.id });
  }

  /** Counts every statement the Postgres query runner executes inside `fn` (all databases in this process). */
  async function countStatements<T>(fn: () => Promise<T>): Promise<{ result: T; statements: number }> {
    const proto = PostgresQueryRunner.prototype as unknown as { query: (...a: unknown[]) => Promise<unknown> };
    const original = proto.query;
    let n = 0;
    proto.query = function (...args: unknown[]) {
      n++;
      return original.apply(this, args);
    };
    try {
      const result = await fn();
      return { result, statements: n };
    } finally {
      proto.query = original;
    }
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'authz_ctx' });
    const cp = h.controlPlane.options as { host: string; port: number; username: string; password: string; database: string };
    ambient = new DataSource({ type: 'postgres', host: cp.host, port: cp.port, username: cp.username, password: cp.password, database: cp.database, entities: [Role, UserRole, RolePermission], synchronize: false });
    await ambient.initialize();
    contexts = new AuthorizationContextService(ambient);
    const authorization = new AuthorizationService(ambient.getRepository(Role), ambient.getRepository(UserRole));
    const permission = new PermissionService(ambient.getRepository(RolePermission), authorization);
    permissionGuard = new PermissionGuard(reflector, permission, contexts);
    legacyPermissionGuard = new PermissionGuard(reflector, permission); // pre-F1 path (no context service)
    rolesGuard = new RolesGuard(reflector, authorization, contexts);

    dsA = await h.connections.getDataSource(h.companyAId);
    dsB = await h.connections.getDataSource(h.companyBId);
    U = (await h.users.create({ fullName: 'Ctx Dual User', email: 'ctx-dual@test.local' })).id;
    await h.memberships.create({ userId: U, companyId: h.companyAId, roleKey: 'sales.manager' });
    await h.memberships.create({ userId: U, companyId: h.companyBId, roleKey: 'sales.viewer' });
    await grantRole(dsA, U, 'sales.manager'); // Company A: editable on the whole sales module
    await grantRole(dsB, U, 'sales.viewer'); // Company B: read-only on the sales module
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('authz-ctx teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  it('one identity, two Companies: each Company authorizes ONLY by its own role set; the platform (ambient) tables grant nothing', async () => {
    const a = await contexts.forRequest(reqFor(h.companyAId, dsA.manager));
    const b = await contexts.forRequest(reqFor(h.companyBId, dsB.manager));
    const platform = await contexts.forRequest({ user: { id: U } } as never);
    expect(a.roleKeys).toEqual(['sales.manager']);
    expect(b.roleKeys).toEqual(['sales.viewer']);
    expect(platform.roleKeys).toEqual([]);
    expect(a.hasAtLeast('sales.order.create', 'editable')).toBe(true);
    expect(b.hasAtLeast('sales.order.create', 'editable')).toBe(false); // B only reads
    expect(b.hasAtLeast('sales.order.view', 'read-only')).toBe(true);
    expect(platform.hasAtLeast('sales.order.view', 'read-only')).toBe(false);
    expect(a.companyId).toBe(h.companyAId);
    expect(b.companyId).toBe(h.companyBId);
  });

  it('guards decide from the request-scoped context: same user is allowed in A, denied (404) in B for the same node; roles guard follows the Company roles', async () => {
    const reqA = reqFor(h.companyAId, dsA.manager);
    const reqB = reqFor(h.companyBId, dsB.manager);
    await expect(permissionGuard.canActivate(ctxFor(reqA, 'create'))).resolves.toBe(true);
    await expect(permissionGuard.canActivate(ctxFor(reqB, 'create'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(permissionGuard.canActivate(ctxFor(reqB, 'view'))).resolves.toBe(true);
    await expect(rolesGuard.canActivate(ctxFor(reqA, 'managerOnly'))).resolves.toBe(true);
    await expect(rolesGuard.canActivate(ctxFor(reqB, 'managerOnly'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('request scope: 5 permission checks + 3 role checks on ONE request cost exactly ONE statement; the pre-F1 path costs 3 per permission check', async () => {
    const req = reqFor(h.companyAId, dsA.manager);
    const withContext = await countStatements(async () => {
      for (let i = 0; i < 5; i++) await permissionGuard.canActivate(ctxFor(req, 'create'));
      for (let i = 0; i < 3; i++) await rolesGuard.canActivate(ctxFor(req, 'managerOnly'));
    });
    expect(withContext.statements).toBe(1);

    const legacy = await countStatements(async () => {
      for (let i = 0; i < 5; i++) await legacyPermissionGuard.canActivate(ctxFor(reqFor(h.companyAId, dsA.manager), 'create'));
    });
    expect(legacy.statements).toBeGreaterThanOrEqual(15); // 3 statements x 5 checks (the cost F1 removes)
  });

  it('stale / revoked: a role removed between two requests denies the SECOND request (no cross-request cache); the first request keeps its own snapshot', async () => {
    const reqBefore = reqFor(h.companyAId, dsA.manager);
    await expect(permissionGuard.canActivate(ctxFor(reqBefore, 'create'))).resolves.toBe(true);
    await revokeRole(dsA, U, 'sales.manager');
    try {
      const reqAfter = reqFor(h.companyAId, dsA.manager);
      await expect(permissionGuard.canActivate(ctxFor(reqAfter, 'create'))).rejects.toBeInstanceOf(NotFoundException);
      await expect(rolesGuard.canActivate(ctxFor(reqAfter, 'managerOnly'))).rejects.toBeInstanceOf(ForbiddenException);
      // the request that already resolved keeps ONE consistent view for its whole lifetime (documented request scope)
      await expect(permissionGuard.canActivate(ctxFor(reqBefore, 'create'))).resolves.toBe(true);
    } finally {
      await grantRole(dsA, U, 'sales.manager');
    }
    await expect(permissionGuard.canActivate(ctxFor(reqFor(h.companyAId, dsA.manager), 'create'))).resolves.toBe(true);
  });

  it('forged authorization input is never an authority: request-borne roles / capabilities / company claims / headers / body do not change the decision', async () => {
    // user is only a VIEWER in Company B; every forged field below claims more
    const forged = reqFor(h.companyBId, dsB.manager, {
      headers: { 'x-company-id': h.companyAId, 'x-roles': 'admin', authorization: 'Bearer forged' },
      body: { companyId: h.companyAId, roles: ['admin'], capabilities: { 'sales.order.create': 'editable' } },
      query: { companyId: h.companyAId },
      roles: ['admin'],
      capabilities: { 'sales.order.create': 'editable' },
      authz: { capabilities: { 'sales.order.create': 'editable' } },
    });
    (forged.user as unknown as Record<string, unknown>).roles = ['admin'];
    (forged.user as unknown as Record<string, unknown>).capabilities = { 'sales.order.create': 'editable' };
    await expect(permissionGuard.canActivate(ctxFor(forged, 'create'))).rejects.toBeInstanceOf(NotFoundException);
    const ctx = await contexts.forRequest(forged);
    expect(ctx.roleKeys).toEqual(['sales.viewer']);
    expect(ctx.companyId).toBe(h.companyBId);

    // a request that CLAIMS Company A but carries no validated Company context never reads A's tables: it resolves in the platform domain (nothing)
    const claimOnly = { user: { id: U, email: 'u@test.local', companyId: h.companyAId } } as unknown as CompanyScopedRequest;
    const claimCtx = await contexts.forRequest(claimOnly);
    expect(claimCtx.roleKeys).toEqual([]);
    expect(claimCtx.hasAtLeast('sales.order.view', 'read-only')).toBe(false);
  });

  it('fail closed: a Company database that cannot be read denies the request (the guard throws, never allows) and the failure is not cached', async () => {
    let broken = true;
    const flaky = {
      query: (sql: string, params: unknown[]) => {
        if (broken) throw new Error('company database unavailable');
        return dsA.manager.query(sql, params);
      },
    };
    const req = reqFor(h.companyAId, flaky);
    await expect(permissionGuard.canActivate(ctxFor(req, 'create'))).rejects.toThrow('company database unavailable');
    broken = false;
    await expect(permissionGuard.canActivate(ctxFor(req, 'create'))).resolves.toBe(true);
  });

  it("a user with no role in a Company has no authority there even if the roles' grants exist (deny by default)", async () => {
    const stranger = randomUUID();
    const req = { user: { id: stranger, email: 's@test.local', companyId: h.companyAId }, companyContext: { companyId: h.companyAId, dataSource: { manager: dsA.manager } } } as unknown as CompanyScopedRequest;
    await expect(permissionGuard.canActivate(ctxFor(req, 'view'))).rejects.toBeInstanceOf(NotFoundException);
  });
});
