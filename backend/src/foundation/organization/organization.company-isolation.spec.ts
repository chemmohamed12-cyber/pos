import { DataSource } from 'typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { CompanyContextGuard, CompanyScopedRequest } from '../company/company-context.guard';
import { PermissionGuard } from '../permission/permission.guard';
import { PermissionService } from '../permission/permission.service';
import { PERMISSION_METADATA_KEY } from '../permission/require-permission.decorator';
import { ROLES_METADATA_KEY, WORKFLOW_RULE_METADATA_KEY } from '../authorization/require-role.decorator';
import { COMPANY_ORGANIZATION_MANAGE_NODE } from '../permission/company-nodes';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { RolePermission } from '../permission/role-permission.entity';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';

/**
 * Authorization Program F1.5 — finding F-1 / AZ-03: the Organization tree is COMPANY data.
 * Before: `JwtAuthGuard` only, every route read/wrote the AMBIENT (platform) org tables — any authenticated user of any Company saw the platform tree.
 * Now: JWT -> CompanyContextGuard -> the Company's own DataSource. Real Postgres, two Companies.
 */
describe('OrganizationController — Company-scoped (F-1 / AZ-03)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let controller: OrganizationController;
  let ambientTouched = 0;
  let adminA: string;
  let viewerB: string;
  let otherA: string;
  let dsA: DataSource;
  let dsB: DataSource;
  let permissionGuard: PermissionGuard;
  let contextGuard: CompanyContextGuard;
  let ambient: DataSource;

  const reqFor = (userId: string, companyId: string, ds: DataSource): CompanyScopedRequest =>
    ({ user: { id: userId, email: 'x@test.local', companyId }, companyContext: { companyId, dataSource: ds } }) as unknown as CompanyScopedRequest;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'org_f1' });
    const cp = h.controlPlane.options as { host: string; port: number; username: string; password: string; database: string };
    ambient = new DataSource({ type: 'postgres', host: cp.host, port: cp.port, username: cp.username, password: cp.password, database: cp.database, entities: [Role, UserRole, RolePermission], synchronize: false });
    await ambient.initialize();
    // POISONED ambient DataSource for the org service: any attempt to read/write the platform org tables fails the test
    const poisoned = { getRepository: () => { ambientTouched++; throw new Error('AMBIENT ORG TABLE TOUCHED'); }, query: () => { ambientTouched++; throw new Error('AMBIENT ORG TABLE TOUCHED'); } } as unknown as DataSource;
    controller = new OrganizationController(new OrganizationService(poisoned));
    const authorization = new AuthorizationService(ambient.getRepository(Role), ambient.getRepository(UserRole));
    void authorization;
    permissionGuard = new PermissionGuard(new Reflector(), {} as PermissionService, new AuthorizationContextService(ambient));
    contextGuard = new CompanyContextGuard(h.memberships, h.companies, h.connections);
    dsA = await h.connections.getDataSource(h.companyAId);
    dsB = await h.connections.getDataSource(h.companyBId);
    adminA = (await h.createUserWithAdminRoleIn('Org Admin A', h.companyAId)).id; // admin in Company A
    viewerB = (await h.users.create({ fullName: 'Org Viewer B', email: 'org-viewer-b@test.local' })).id;
    await h.memberships.create({ userId: viewerB, companyId: h.companyBId, roleKey: 'sales.viewer' });
    otherA = (await h.users.create({ fullName: 'Org Member A', email: 'org-member-a@test.local' })).id;
    await h.memberships.create({ userId: otherA, companyId: h.companyAId, roleKey: 'sales.viewer' });
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('org teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  it('metadata: every route runs JwtAuthGuard then CompanyContextGuard; every WRITE route runs PermissionGuard on the Company administration node core.company.organization.manage (editable) — CTO ruling B1, no workflow rule', () => {
    const guards = Reflect.getMetadata('__guards__', OrganizationController) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, CompanyContextGuard]);
    for (const m of ['createUnit', 'assignMember', 'removeMember'] as const) {
      const handler = OrganizationController.prototype[m];
      expect(Reflect.getMetadata('__guards__', handler)).toEqual([PermissionGuard]);
      expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toEqual({ nodeKey: COMPANY_ORGANIZATION_MANAGE_NODE, access: 'editable' });
      expect(Reflect.getMetadata(WORKFLOW_RULE_METADATA_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(ROLES_METADATA_KEY, handler)).toBeUndefined();
    }
    for (const m of ['listUnits', 'listMembers'] as const) expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, OrganizationController.prototype[m])).toBeUndefined(); // reads: any Company member, unchanged
  });

  it('units created in Company A are visible in A and ABSENT in B; the ambient org tables are never touched', async () => {
    const reqA = reqFor(adminA, h.companyAId, dsA);
    const reqB = reqFor(viewerB, h.companyBId, dsB);
    const branch = await controller.createUnit(reqA, { type: 'branch', name: 'Alpha Cairo' });
    expect(await controller.listUnits(reqA)).toEqual([expect.objectContaining({ id: branch.id, name: 'Alpha Cairo' })]);
    expect(await controller.listUnits(reqB)).toEqual([]); // Company B sees nothing of A
    // Company B's own unit stays in B
    const bUnit = await controller.createUnit(reqB, { type: 'warehouse', name: 'Beta Main WH' });
    expect((await controller.listUnits(reqA)).map((u) => u.name)).toEqual(['Alpha Cairo']);
    expect((await controller.listUnits(reqB)).map((u) => u.name)).toEqual(['Beta Main WH']);
    expect(bUnit.id).not.toBe(branch.id);
    expect(ambientTouched).toBe(0);
  });

  it("members: assignment and listing are Company-local; A's unit id is unknown to B (404) and B cannot attach members to it", async () => {
    const reqA = reqFor(adminA, h.companyAId, dsA);
    const reqB = reqFor(viewerB, h.companyBId, dsB);
    const unitA = (await controller.listUnits(reqA))[0];
    await controller.assignMember(reqA, unitA.id, { userId: otherA });
    expect(await controller.listMembers(reqA, unitA.id)).toEqual([otherA]);
    expect(await controller.listMembers(reqB, unitA.id)).toEqual([]); // B asks about A's unit: nothing
    await expect(controller.assignMember(reqB, unitA.id, { userId: otherA })).rejects.toThrow(/not found/i); // a B member addressing A's unit: the Company data layer itself knows no such unit
    expect(await controller.listMembers(reqA, unitA.id)).toEqual([otherA]); // unchanged
    await controller.removeMember(reqA, unitA.id, otherA);
    expect(await controller.listMembers(reqA, unitA.id)).toEqual([]);
    expect(ambientTouched).toBe(0);
  });

  it('CompanyContextGuard: a user who is not a member of the Company (forged company claim) is refused before any org data is reachable', async () => {
    const forged = { user: { id: viewerB, email: 'x', companyId: h.companyAId } } as unknown as CompanyScopedRequest;
    const ctx = { switchToHttp: () => ({ getRequest: () => forged }), getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
    await expect(contextGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(forged.companyContext).toBeUndefined();
    const noClaim = { user: { id: viewerB, email: 'x' } } as unknown as CompanyScopedRequest;
    await expect(contextGuard.canActivate({ switchToHttp: () => ({ getRequest: () => noClaim }) } as unknown as ExecutionContext)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("writes are gated by the Company administration node, resolved from the Company's own roles: A's administrator (legacy admin, reclassified) passes, B's viewer is refused (404)", async () => {
    const ctxFor = (req: unknown) => ({ getHandler: () => OrganizationController.prototype.createUnit, getClass: () => OrganizationController, switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;
    await expect(permissionGuard.canActivate(ctxFor(reqFor(adminA, h.companyAId, dsA)))).resolves.toBe(true);
    await expect(permissionGuard.canActivate(ctxFor(reqFor(viewerB, h.companyBId, dsB)))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('NO SELF-ELEVATION through the org tree: an org-unit membership is a scope source, so nobody may add THEMSELVES to a unit (SELF_SCOPE_CHANGE, nothing written); removing oneself is narrowing and stays allowed', async () => {
    const reqA = reqFor(adminA, h.companyAId, dsA);
    const unitA = (await controller.listUnits(reqA))[0];
    await expect(controller.assignMember(reqA, unitA.id, { userId: adminA })).rejects.toMatchObject({ code: 'SELF_SCOPE_CHANGE', status: 403 });
    expect(await controller.listMembers(reqA, unitA.id)).toEqual([]); // nothing was written
    await dsA.query(`INSERT INTO org_memberships ("userId", "orgUnitId") VALUES ($1, $2)`, [adminA, unitA.id]); // placed there by someone else
    await controller.removeMember(reqA, unitA.id, adminA);
    expect(await controller.listMembers(reqA, unitA.id)).toEqual([]);
  });
});
