import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CompanyContextGuard, CompanyScopedRequest } from './company-context.guard';
import { MembershipService } from './membership.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { PermissionGuard } from '../permission/permission.guard';
import { PermissionService } from '../permission/permission.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { RolePermission } from '../permission/role-permission.entity';
import { CompanyUsersController } from './company-users.controller';
import { COMPANY_MEMBERS_MANAGE_NODE } from './company-role-seeding';

/**
 * Track A closure gate, point 1 (2026-09-24 CTO directive). The
 * `PermissionGuard → PermissionService` path had no composed acceptance
 * proof analogous to `area6-company-isolation.acceptance.spec.ts` (which
 * only composes `RolesGuard`/`AuthorizationService`). This file closes
 * exactly that gap — nothing else. No D1–D9 code touched, no redesign.
 *
 * Composes the REAL chain:
 *   CompanyContextGuard → PermissionGuard → PermissionService
 *   → AuthorizationService → Company DataSource
 * against the REAL `CompanyUsersController` class (its actual
 * class-level `@RequirePermission(core.company.members.manage, 'editable')`
 * decorator, not a stand-in), with the AMBIENT (platform) `Role`/
 * `UserRole`/`RolePermission` repos poisoned, and two Companies with
 * their own, independent Role/RolePermission grants.
 */
const AMBIENT_TOUCHED = 'AMBIENT REPOSITORY TOUCHED — the permission path must never reach the platform tables for a Company-scoped request';

function poisonedAmbientRepo() {
  return {
    find: jest.fn(() => {
      throw new Error(AMBIENT_TOUCHED);
    }),
  };
}

function makeCompanyDataSource(grantNodeForAdmin: string | null) {
  const roles = new Map<string, Role>([['role-admin', { id: 'role-admin', key: 'admin', createdAt: new Date() } as Role]]);
  const userRoles = new Map<string, UserRole>([['ur-1', { id: 'ur-1', userId: 'alice', roleId: 'role-admin', assignedAt: new Date() } as UserRole]]);
  const rolePermissions = new Map<string, RolePermission>();
  if (grantNodeForAdmin) {
    rolePermissions.set('rp-1', { id: 'rp-1', roleId: 'role-admin', nodeKey: grantNodeForAdmin, access: 'editable', createdAt: new Date() } as RolePermission);
  }

  const roleRepo = { find: jest.fn(async () => [...roles.values()]) };
  const userRoleRepo = { find: jest.fn(async ({ where }: { where: { userId: string } }) => [...userRoles.values()].filter((ur) => ur.userId === where.userId)) };
  const rolePermissionRepo = {
    find: jest.fn(async ({ where }: { where: { roleId: unknown; nodeKey: unknown } }) => {
      void where;
      return [...rolePermissions.values()]; // fixture has one role only — real filtering already proven in permission.service.spec.ts
    }),
  };
  const manager = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity === Role) return roleRepo;
      if (entity === UserRole) return userRoleRepo;
      if (entity === RolePermission) return rolePermissionRepo;
      throw new Error(`unexpected entity in fixture: ${String(entity)}`);
    }),
  };
  return { dataSource: { manager } };
}

function fakeGuardContext(request: Partial<CompanyScopedRequest>): ExecutionContext {
  return {
    getHandler: () => CompanyUsersController.prototype.invite,
    getClass: () => CompanyUsersController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('Permission-path composed isolation — CompanyContextGuard → PermissionGuard → PermissionService → Company DataSource', () => {
  const membershipsMock = { findActiveByUserAndCompany: jest.fn() };
  const connectionsMock = { getDataSource: jest.fn() };
  let companyContextGuard: CompanyContextGuard;
  let permissionGuard: PermissionGuard;
  let authorization: AuthorizationService;
  let permission: PermissionService;
  let companyA: ReturnType<typeof makeCompanyDataSource>;
  let companyB: ReturnType<typeof makeCompanyDataSource>;

  beforeEach(() => {
    jest.clearAllMocks();
    companyContextGuard = new CompanyContextGuard(membershipsMock as unknown as MembershipService, { findById: jest.fn(async () => ({ id: 'c', status: 'READY' })) } as never, connectionsMock as unknown as CompanyConnectionManagerService);
    // REAL AuthorizationService/PermissionService, with the AMBIENT (platform) repos poisoned —
    // proves the whole composed chain, not just PermissionGuard in isolation, never falls back.
    authorization = new AuthorizationService(poisonedAmbientRepo() as never, poisonedAmbientRepo() as never);
    permission = new PermissionService(poisonedAmbientRepo() as never, authorization);
    permissionGuard = new PermissionGuard(new Reflector(), permission);

    // Company A: alice's 'admin' role IS granted core.company.members.manage.
    companyA = makeCompanyDataSource(COMPANY_MEMBERS_MANAGE_NODE);
    // Company B: alice's 'admin' role there is granted a DIFFERENT node only — no bleed from A.
    companyB = makeCompanyDataSource('sales');
  });

  async function runChain(userId: string, companyId: string): Promise<CompanyScopedRequest> {
    const request = { user: { id: userId, email: `${userId}@x.com`, companyId } } as unknown as CompanyScopedRequest;
    await companyContextGuard.canActivate(fakeGuardContext(request));
    await permissionGuard.canActivate(fakeGuardContext(request));
    return request;
  }

  it('grants access when the Company-scoped role actually holds core.company.members.manage, and never touches the ambient (poisoned) platform tables', async () => {
    membershipsMock.findActiveByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'alice', companyId: 'company-A', roleKey: 'admin' });
    connectionsMock.getDataSource.mockResolvedValue(companyA.dataSource);

    // If PermissionGuard/PermissionService/AuthorizationService ever fell back to the ambient
    // repos for this Company-scoped request, this would throw AMBIENT_TOUCHED instead of resolving.
    await expect(runChain('alice', 'company-A')).resolves.toBeDefined();
  });

  it('the SAME user\'s grant in Company A does NOT carry over to Company B — denied there despite being an "admin" in both', async () => {
    membershipsMock.findActiveByUserAndCompany.mockResolvedValue({ id: 'm-2', userId: 'alice', companyId: 'company-B', roleKey: 'admin' });
    connectionsMock.getDataSource.mockResolvedValue(companyB.dataSource);

    // Company B's own 'admin' role does NOT grant core.company.members.manage (only 'sales') —
    // PermissionGuard must deny with its standard anti-enumeration 404, never a leaked "yes" from A.
    await expect(runChain('alice', 'company-B')).rejects.toThrow(NotFoundException);
  });

  it('a user with no Membership in Company B is rejected at CompanyContextGuard — PermissionService/Company B\'s DataSource is never reached, regardless of any client-supplied companyId', async () => {
    membershipsMock.findActiveByUserAndCompany.mockResolvedValue(null); // not a member of Company B at all

    const request = { user: { id: 'mallory', email: 'mallory@x.com', companyId: 'company-B' } } as unknown as CompanyScopedRequest;
    await expect(companyContextGuard.canActivate(fakeGuardContext(request))).rejects.toThrow(ForbiddenException);

    expect(connectionsMock.getDataSource).not.toHaveBeenCalled();
  });

  it('a route with NO Company context still enforces via the ambient path (proves the ambient path is real, not dead code)', async () => {
    const request = { user: { id: 'platform-admin', email: 'a@x.com' } } as unknown as CompanyScopedRequest; // no companyId claim
    await expect(permissionGuard.canActivate(fakeGuardContext(request))).rejects.toThrow(AMBIENT_TOUCHED);
  });
});
