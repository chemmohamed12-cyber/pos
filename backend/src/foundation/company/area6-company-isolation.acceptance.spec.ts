import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CompanyContextGuard, CompanyScopedRequest } from './company-context.guard';
import { MembershipService } from './membership.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { RolesGuard } from '../authorization/roles.guard';
import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';

/**
 * Multi-Company Area 6 acceptance criteria (2026-09-23, locked instruction
 * — "هذه النقاط جزء من Area 6 acceptance، وليست optional tests"). Proves
 * all 7 points TOGETHER, composing the REAL `CompanyContextGuard` →
 * `RolesGuard` → `AuthorizationService` chain (only `MembershipService`,
 * `CompanyConnectionManagerService`, and the two Companies' own
 * Role/UserRole tables are test doubles) — not each piece in isolation.
 */
const AMBIENT_TOUCHED = 'AMBIENT REPOSITORY TOUCHED — a Company-scoped request must never reach the platform tables';

function poisonedAmbientRepo() {
  return {
    find: jest.fn(() => {
      throw new Error(AMBIENT_TOUCHED);
    }),
  };
}

function makeCompanyDataSource(roleKeyForAlice: string | null) {
  const roles = new Map<string, Role>();
  const userRoles = new Map<string, UserRole>();
  if (roleKeyForAlice) {
    const role = { id: `role-${roleKeyForAlice}`, key: roleKeyForAlice, createdAt: new Date() } as Role;
    roles.set(role.id, role);
    userRoles.set('ur-alice', { id: 'ur-alice', userId: 'alice', roleId: role.id, assignedAt: new Date() } as UserRole);
  }
  const roleRepo = { find: jest.fn(async () => [...roles.values()]) };
  const userRoleRepo = { find: jest.fn(async ({ where }: { where: { userId: string } }) => [...userRoles.values()].filter((ur) => ur.userId === where.userId)) };
  const manager = { getRepository: jest.fn((entity: unknown) => (entity === Role ? roleRepo : userRoleRepo)) };
  // Mirrors the real `DataSource` shape `CompanyConnectionManagerService.getDataSource` returns —
  // `CompanyContextGuard` stores this whole object, and `RolesGuard` reads `.manager` off it.
  const dataSource = { manager };
  return { dataSource, manager, roleRepo, userRoleRepo };
}

function fakeGuardContext(request: Partial<CompanyScopedRequest>): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('Area 6 acceptance — Company authorization isolation (composed guard chain, not mocked in isolation)', () => {
  const membershipsMock = { findActiveByUserAndCompany: jest.fn() };
  const connectionsMock = { getDataSource: jest.fn() };
  let companyContextGuard: CompanyContextGuard;
  let rolesGuard: RolesGuard;
  let authorization: AuthorizationService;
  let companyA: ReturnType<typeof makeCompanyDataSource>;
  let companyB: ReturnType<typeof makeCompanyDataSource>;

  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(['accountant', 'viewer', 'admin']) } as unknown as Reflector;

  beforeEach(() => {
    jest.clearAllMocks();
    reflector.getAllAndOverride = jest.fn().mockReturnValue(['accountant', 'viewer', 'admin']);
    companyContextGuard = new CompanyContextGuard(membershipsMock as unknown as MembershipService, { findById: jest.fn(async () => ({ id: 'c', status: 'READY' })) } as never, connectionsMock as unknown as CompanyConnectionManagerService);
    // Real AuthorizationService, with the AMBIENT (platform) repos poisoned — proves point 7
    // (no fallback to ambient) for the whole composed chain, not just this one service in isolation.
    authorization = new AuthorizationService(poisonedAmbientRepo() as never, poisonedAmbientRepo() as never);
    rolesGuard = new RolesGuard(reflector, authorization);

    companyA = makeCompanyDataSource('accountant'); // alice's role in Company A
    companyB = makeCompanyDataSource('viewer'); // alice's DIFFERENT role in Company B
  });

  async function runChain(userId: string, companyId: string): Promise<CompanyScopedRequest> {
    const request = { user: { id: userId, email: `${userId}@x.com`, companyId } } as unknown as CompanyScopedRequest;
    await companyContextGuard.canActivate(fakeGuardContext(request));
    await rolesGuard.canActivate(fakeGuardContext(request));
    return request;
  }

  it('1+2+3. the same user sees DIFFERENT, correctly-isolated roles in Company A vs Company B — no bleed either direction', async () => {
    membershipsMock.findActiveByUserAndCompany.mockImplementation(async (userId: string, companyId: string) =>
      userId === 'alice' ? { id: 'm', userId, companyId, roleKey: companyId === 'company-A' ? 'accountant' : 'viewer' } : null,
    );
    connectionsMock.getDataSource.mockImplementation(async (companyId: string) => (companyId === 'company-A' ? companyA.dataSource : companyB.dataSource));

    const roleKeysA = await authorization.getRoleKeysForUser('alice', (await runChain('alice', 'company-A')).companyContext!.dataSource.manager);
    const roleKeysB = await authorization.getRoleKeysForUser('alice', (await runChain('alice', 'company-B')).companyContext!.dataSource.manager);

    expect(roleKeysA).toEqual(['accountant']);
    expect(roleKeysB).toEqual(['viewer']);
    expect(roleKeysA).not.toEqual(roleKeysB); // Company A's role never appears in Company B's result or vice versa
  });

  it('4+5. a user NOT a member of Company B is rejected before Company B\'s database is ever selected', async () => {
    membershipsMock.findActiveByUserAndCompany.mockImplementation(async (userId: string, companyId: string) => (userId === 'bob' && companyId === 'company-A' ? { id: 'm', userId, companyId, roleKey: 'accountant' } : null));

    const request = { user: { id: 'bob', email: 'bob@x.com', companyId: 'company-B' } } as unknown as CompanyScopedRequest;
    await expect(companyContextGuard.canActivate(fakeGuardContext(request))).rejects.toThrow(ForbiddenException);

    expect(connectionsMock.getDataSource).not.toHaveBeenCalledWith('company-B');
    expect(connectionsMock.getDataSource).not.toHaveBeenCalled();
  });

  it('6. revoking Membership blocks access on the very next request — nothing cached from the prior successful one', async () => {
    membershipsMock.findActiveByUserAndCompany.mockResolvedValueOnce({ id: 'm', userId: 'alice', companyId: 'company-A', roleKey: 'accountant' });
    connectionsMock.getDataSource.mockResolvedValueOnce(companyA.dataSource);
    const firstRequest = { user: { id: 'alice', email: 'alice@x.com', companyId: 'company-A' } } as unknown as CompanyScopedRequest;
    await expect(companyContextGuard.canActivate(fakeGuardContext(firstRequest))).resolves.toBe(true);

    membershipsMock.findActiveByUserAndCompany.mockResolvedValueOnce(null); // revoked
    const secondRequest = { user: { id: 'alice', email: 'alice@x.com', companyId: 'company-A' } } as unknown as CompanyScopedRequest;
    await expect(companyContextGuard.canActivate(fakeGuardContext(secondRequest))).rejects.toThrow(ForbiddenException);
  });

  it('7. RolesGuard never falls back to the ambient (platform) tables for a Company-scoped request — proven by a poisoned ambient AuthorizationService', async () => {
    membershipsMock.findActiveByUserAndCompany.mockResolvedValue({ id: 'm', userId: 'alice', companyId: 'company-A', roleKey: 'accountant' });
    connectionsMock.getDataSource.mockResolvedValue(companyA.dataSource);

    // If RolesGuard/AuthorizationService ever fell back to the ambient repos for this
    // Company-scoped request, this would throw AMBIENT_TOUCHED instead of succeeding.
    await expect(runChain('alice', 'company-A')).resolves.toBeDefined();
  });

  it('7b. a route with NO Company context still uses the ambient path by design (proves the ambient path itself is real, not dead code)', async () => {
    const request = { user: { id: 'platform-admin', email: 'a@x.com' } } as unknown as CompanyScopedRequest; // no companyId claim at all
    await expect(rolesGuard.canActivate(fakeGuardContext(request))).rejects.toThrow(AMBIENT_TOUCHED);
  });
});
