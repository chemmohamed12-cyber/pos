import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionGuard } from './permission.guard';
import { PermissionService } from './permission.service';
import { RequirePermission } from './require-permission.decorator';
import { CompanyScopedRequest } from '../company/company-context.guard';

function fakeContext(request: Partial<CompanyScopedRequest>): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('PermissionGuard — Multi-Company Area 6 (2026-09-23): routes through Company context when present', () => {
  let guard: PermissionGuard;
  const permissionMock = { hasAtLeast: jest.fn() };
  const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new PermissionGuard(reflector, permissionMock as unknown as PermissionService);
  });

  it('passes the Company DataSource manager through when CompanyContextGuard already ran', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({ nodeKey: 'accounting.journal', access: 'read-only' });
    permissionMock.hasAtLeast.mockResolvedValue(true);
    const manager = { tag: 'company-a-manager' };
    const request: CompanyScopedRequest = {
      user: { id: 'user-1', email: 'a@b.com', companyId: 'company-A' },
      companyContext: { companyId: 'company-A', dataSource: { manager } as never },
    } as unknown as CompanyScopedRequest;

    await guard.canActivate(fakeContext(request));

    expect(permissionMock.hasAtLeast).toHaveBeenCalledWith('user-1', 'accounting.journal', 'read-only', manager);
  });

  it('passes undefined (ambient) when no Company context is on the request', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({ nodeKey: 'accounting.journal', access: 'read-only' });
    permissionMock.hasAtLeast.mockResolvedValue(true);
    const request = { user: { id: 'user-1', email: 'a@b.com' } };

    await guard.canActivate(fakeContext(request));

    expect(permissionMock.hasAtLeast).toHaveBeenCalledWith('user-1', 'accounting.journal', 'read-only', undefined);
  });

  it('denies with 404 (anti-enumeration, unchanged) when the Company-scoped permission check fails', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({ nodeKey: 'accounting.journal', access: 'editable' });
    permissionMock.hasAtLeast.mockResolvedValue(false);
    const request: CompanyScopedRequest = {
      user: { id: 'user-1', email: 'a@b.com', companyId: 'company-B' },
      companyContext: { companyId: 'company-B', dataSource: { manager: {} } as never },
    } as unknown as CompanyScopedRequest;

    await expect(guard.canActivate(fakeContext(request))).rejects.toThrow(NotFoundException);
  });

  describe('REAL BUG FIX (2026-09-24) — class-level @RequirePermission, real Reflector (no mock)', () => {
    it('is actually enforced when @RequirePermission is applied at the class level, not just the handler', async () => {
      @RequirePermission('core.company.members.manage', 'editable')
      class FakeCompanyScopedController {
        handler() {
          /* no-op */
        }
      }
      const realReflector = new Reflector();
      const realGuard = new PermissionGuard(realReflector, permissionMock as unknown as PermissionService);
      permissionMock.hasAtLeast.mockResolvedValue(false); // caller lacks the permission

      const context = {
        getHandler: () => FakeCompanyScopedController.prototype.handler,
        getClass: () => FakeCompanyScopedController,
        switchToHttp: () => ({ getRequest: () => ({ user: { id: 'user-1', email: 'a@b.com' } }) }),
      } as unknown as ExecutionContext;

      // Before the fix, `.get(key, context.getHandler())` alone never saw this
      // class-level metadata and silently let every caller through.
      await expect(realGuard.canActivate(context)).rejects.toThrow(NotFoundException);
      expect(permissionMock.hasAtLeast).toHaveBeenCalledWith('user-1', 'core.company.members.manage', 'editable', undefined);
    });
  });
});
