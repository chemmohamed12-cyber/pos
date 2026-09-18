import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { RequireRole } from './require-role.decorator';
import { AuthorizationService } from './authorization.service';

/**
 * REAL BUG FOUND LIVE (CTO directive — customer-scope review): `RolesGuard`
 * used to read metadata via `reflector.get(key, context.getHandler())`
 * only. `@RequireRole` applied at the CLASS level (AdminController's
 * `@RequireRole('admin')` covering `GET /admin/users` and
 * `POST /admin/roles/assign`) attaches to the constructor, which
 * `getHandler()` never sees — so `requiredRoles` came back `undefined` and
 * the guard let ANY authenticated user through, regardless of role.
 * Confirmed by querying the live dev DB: `AdminController` had no
 * per-method `@RequireRole`, unlike every other role-gated controller in
 * this codebase, which all annotate the method directly.
 */
describe('RolesGuard', () => {
  const authorizationMock = {
    getRoleKeysForUser: jest.fn(async (userId: string) => (userId === 'admin-1' ? ['admin'] : ['sales_rep'])),
  } as unknown as AuthorizationService;

  function makeContext(userId: string | undefined, handlerRoles: string[] | undefined, classRoles: string[] | undefined): ExecutionContext {
    class FakeController {}
    if (classRoles) RequireRole(...classRoles)(FakeController);
    function handler() {}
    if (handlerRoles) RequireRole(...handlerRoles)(FakeController.prototype, 'handler', {
      value: handler,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return {
      getHandler: () => handler,
      getClass: () => FakeController,
      switchToHttp: () => ({ getRequest: () => ({ user: userId ? { id: userId } : undefined }) }),
    } as unknown as ExecutionContext;
  }

  it('enforces a CLASS-level @RequireRole (the exact live gap: AdminController never had a method-level one)', async () => {
    const guard = new RolesGuard(new Reflector(), authorizationMock);
    const context = makeContext('rep-1', undefined, ['admin']);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a class-level @RequireRole when the user actually holds the role', async () => {
    const guard = new RolesGuard(new Reflector(), authorizationMock);
    const context = makeContext('admin-1', undefined, ['admin']);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('still enforces a METHOD-level @RequireRole exactly as before (no regression for every other controller)', async () => {
    const guard = new RolesGuard(new Reflector(), authorizationMock);
    const context = makeContext('rep-1', ['admin'], undefined);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a handler-level @RequireRole overrides a stricter class-level one, same NestJS getAllAndOverride precedence everywhere else', async () => {
    const guard = new RolesGuard(new Reflector(), authorizationMock);
    const context = makeContext('rep-1', ['sales_rep'], ['admin']);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('routes with no @RequireRole anywhere stay open to any authenticated user', async () => {
    const guard = new RolesGuard(new Reflector(), authorizationMock);
    const context = makeContext('rep-1', undefined, undefined);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
