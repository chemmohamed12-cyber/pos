import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { AuthorizationService } from './authorization.service';
import { CompanyScopedRequest } from '../company/company-context.guard';

function fakeContext(request: Partial<CompanyScopedRequest>): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard — Multi-Company Area 6 (2026-09-23): routes through Company context when present', () => {
  let guard: RolesGuard;
  const authorizationMock = { getRoleKeysForUser: jest.fn() };
  const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new RolesGuard(reflector, authorizationMock as unknown as AuthorizationService);
  });

  it('passes the Company DataSource manager through when CompanyContextGuard already ran', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['accountant']);
    authorizationMock.getRoleKeysForUser.mockResolvedValue(['accountant']);
    const manager = { tag: 'company-a-manager' };
    const request: CompanyScopedRequest = {
      user: { id: 'user-1', email: 'a@b.com', companyId: 'company-A' },
      companyContext: { companyId: 'company-A', dataSource: { manager } as never },
    } as unknown as CompanyScopedRequest;

    await guard.canActivate(fakeContext(request));

    expect(authorizationMock.getRoleKeysForUser).toHaveBeenCalledWith('user-1', manager);
  });

  it('passes undefined (ambient) when no Company context is on the request — unchanged behavior for routes not using CompanyContextGuard', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['admin']);
    authorizationMock.getRoleKeysForUser.mockResolvedValue(['admin']);
    const request = { user: { id: 'user-1', email: 'a@b.com' } };

    await guard.canActivate(fakeContext(request));

    expect(authorizationMock.getRoleKeysForUser).toHaveBeenCalledWith('user-1', undefined);
  });

  it('rejects when the resolved (Company-scoped) roles do not include the required one', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['admin']);
    authorizationMock.getRoleKeysForUser.mockResolvedValue(['accountant']); // this user's role in Company A
    const request: CompanyScopedRequest = {
      user: { id: 'user-1', email: 'a@b.com', companyId: 'company-A' },
      companyContext: { companyId: 'company-A', dataSource: { manager: {} } as never },
    } as unknown as CompanyScopedRequest;

    await expect(guard.canActivate(fakeContext(request))).rejects.toThrow(ForbiddenException);
  });
});
