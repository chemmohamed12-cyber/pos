import { ConflictException, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { CompanyContextGuard, CompanyScopedRequest } from './company-context.guard';
import { MembershipService } from './membership.service';
import { CompanyService } from './company.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';

function fakeContext(request: Partial<CompanyScopedRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('CompanyContextGuard — Multi-Company Area 5/6 (2026-09-23, locked decision)', () => {
  let guard: CompanyContextGuard;
  const membershipsMock = { findActiveByUserAndCompany: jest.fn() };
  const companiesMock = { findById: jest.fn() };
  const connectionsMock = { getDataSource: jest.fn(), readRegistry: jest.fn(async () => undefined) }; // readRegistry: control-plane read only; undefined => getDataSource loads the registry itself

  beforeEach(() => {
    jest.clearAllMocks();
    companiesMock.findById.mockResolvedValue({ id: 'company-A', status: 'READY' });
    guard = new CompanyContextGuard(membershipsMock as unknown as MembershipService, companiesMock as unknown as CompanyService, connectionsMock as unknown as CompanyConnectionManagerService);
  });

  it('rejects when there is no authenticated user at all', async () => {
    await expect(guard.canActivate(fakeContext({}))).rejects.toThrow(UnauthorizedException);
    expect(membershipsMock.findActiveByUserAndCompany).not.toHaveBeenCalled();
  });

  it('rejects when the token carries no companyId claim — never assumes an ambient/default Company', async () => {
    await expect(guard.canActivate(fakeContext({ user: { id: 'user-1', email: 'a@b.com' } }))).rejects.toThrow(ForbiddenException);
    expect(membershipsMock.findActiveByUserAndCompany).not.toHaveBeenCalled();
  });

  it('rejects a user who is not a member of the claimed Company — and NEVER resolves that Company\'s DataSource first', async () => {
    membershipsMock.findActiveByUserAndCompany.mockResolvedValue(null);
    const request = { user: { id: 'user-1', email: 'a@b.com', companyId: 'company-B' } };

    await expect(guard.canActivate(fakeContext(request))).rejects.toThrow(ForbiddenException);

    expect(membershipsMock.findActiveByUserAndCompany).toHaveBeenCalledWith('user-1', 'company-B');
    expect(connectionsMock.getDataSource).not.toHaveBeenCalled(); // Company B's DB is never even connected to
  });

  it('re-validates Membership against the database on every call — a revoked Membership is rejected on the very next check, nothing cached', async () => {
    membershipsMock.findActiveByUserAndCompany.mockResolvedValueOnce({ id: 'm-1', userId: 'user-1', companyId: 'company-A', roleKey: 'accountant' });
    connectionsMock.getDataSource.mockResolvedValueOnce({ tag: 'company-a-ds' });
    const request: CompanyScopedRequest = { user: { id: 'user-1', email: 'a@b.com', companyId: 'company-A' } } as CompanyScopedRequest;
    await guard.canActivate(fakeContext(request));
    expect(request.companyContext?.companyId).toBe('company-A');

    // Membership revoked between requests — the guard re-queries fresh, no cache.
    membershipsMock.findActiveByUserAndCompany.mockResolvedValueOnce(null);
    const secondRequest = { user: { id: 'user-1', email: 'a@b.com', companyId: 'company-A' } };
    await expect(guard.canActivate(fakeContext(secondRequest))).rejects.toThrow(ForbiddenException);
  });

  it('on a valid Membership, resolves that Company\'s own DataSource and attaches companyContext to the request', async () => {
    membershipsMock.findActiveByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-A', roleKey: 'accountant' });
    const dataSource = { tag: 'company-a-ds' };
    connectionsMock.getDataSource.mockResolvedValue(dataSource);
    const request: CompanyScopedRequest = { user: { id: 'user-1', email: 'a@b.com', companyId: 'company-A' } } as CompanyScopedRequest;

    const result = await guard.canActivate(fakeContext(request));

    expect(result).toBe(true);
    expect(request.companyContext).toEqual({ companyId: 'company-A', dataSource });
  });

  it('propagates a not-ACTIVE-Company rejection from CompanyConnectionManagerService unchanged — never silently proceeds', async () => {
    membershipsMock.findActiveByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-A', roleKey: 'accountant' });
    connectionsMock.getDataSource.mockRejectedValue(new Error("Company company-A's database is 'SUSPENDED', not 'ACTIVE'"));
    const request = { user: { id: 'user-1', email: 'a@b.com', companyId: 'company-A' } };

    await expect(guard.canActivate(fakeContext(request))).rejects.toThrow("not 'ACTIVE'");
  });
  describe('WP-4.1 / DP-9 Layer 1 — READY-only admission', () => {
    const member = { id: 'm-1', userId: 'user-1', companyId: 'company-A', roleKey: 'accountant' };
    const requestFor = (companyId = 'company-A') => ({ user: { id: 'user-1', email: 'a@b.com', companyId } });

    it.each(['PROVISIONING', 'DEGRADED', 'SUSPENDED', 'MIGRATING', 'FAILED', 'DECOMMISSIONED'])('%s → 409 COMPANY_NOT_READY, and the Company DataSource is never requested', async (status) => {
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue(member);
      companiesMock.findById.mockResolvedValue({ id: 'company-A', status });

      const err = await guard.canActivate(fakeContext(requestFor())).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ statusCode: 409, code: 'COMPANY_NOT_READY' });
      expect(JSON.stringify((err as ConflictException).getResponse())).not.toContain(status); // no internal state in the response
      expect(connectionsMock.getDataSource).not.toHaveBeenCalled();
    });

    it('READY → allowed', async () => {
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue(member);
      connectionsMock.getDataSource.mockResolvedValue({ tag: 'ds' });
      await expect(guard.canActivate(fakeContext(requestFor()))).resolves.toBe(true);
      expect(companiesMock.findById).toHaveBeenCalledWith('company-A');
    });

    it('reads the status on EVERY request (no cache): READY then SUSPENDED between two calls with the same claim → the second is blocked', async () => {
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue(member);
      connectionsMock.getDataSource.mockResolvedValue({ tag: 'ds' });
      companiesMock.findById.mockResolvedValueOnce({ id: 'company-A', status: 'READY' }).mockResolvedValueOnce({ id: 'company-A', status: 'SUSPENDED' });
      await expect(guard.canActivate(fakeContext(requestFor()))).resolves.toBe(true);
      await expect(guard.canActivate(fakeContext(requestFor()))).rejects.toThrow(ConflictException);
      expect(companiesMock.findById).toHaveBeenCalledTimes(2);
      expect(connectionsMock.getDataSource).toHaveBeenCalledTimes(1);
    });

    it('a non-member of a SUSPENDED Company gets the Membership rejection, not 409 (membership first — no state leak), and the status is not even read', async () => {
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue(null);
      companiesMock.findById.mockResolvedValue({ id: 'company-A', status: 'SUSPENDED' });
      await expect(guard.canActivate(fakeContext(requestFor()))).rejects.toThrow(ForbiddenException);
      expect(companiesMock.findById).not.toHaveBeenCalled();
    });

    it('a Membership pointing at a Company row that does not exist is reported like a missing Membership (no existence leak) and opens no DataSource', async () => {
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue(member);
      companiesMock.findById.mockResolvedValue(null);
      await expect(guard.canActivate(fakeContext(requestFor()))).rejects.toThrow(ForbiddenException);
      expect(connectionsMock.getDataSource).not.toHaveBeenCalled();
    });
  });
});
