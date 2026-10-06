import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequireModuleGuard, REQUIRE_MODULE_METADATA_KEY } from './require-module.decorator';
import { RequireFeatureGuard, REQUIRE_FEATURE_METADATA_KEY } from './require-feature.decorator';

class Controller {
  handler() {
    return undefined;
  }
}

function ctx(metadataKey: string, code: string, request: Record<string, unknown>): { context: ExecutionContext; reflector: Reflector } {
  const reflector = new Reflector();
  Reflect.defineMetadata(metadataKey, code, Controller.prototype.handler);
  const context = {
    getHandler: () => Controller.prototype.handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, reflector };
}

const installation = (modules: string[], features: string[] = []) => ({
  isModuleEntitled: (m: string) => modules.includes(m),
  isFeatureEntitled: (f: string) => features.includes(f),
  activeEditionCode: () => 'DAII_STANDARD',
});

describe('RequireModuleGuard / RequireFeatureGuard — Company-aware', () => {
  it('without a validated Company context it uses the installation entitlement (unchanged)', async () => {
    const { context, reflector } = ctx(REQUIRE_MODULE_METADATA_KEY, 'logistics', {});
    const company = { isModuleEntitled: jest.fn(), isFeatureEntitled: jest.fn() };
    const guard = new RequireModuleGuard(reflector, installation(['logistics']) as never, company as never);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(company.isModuleEntitled).not.toHaveBeenCalled();
  });

  it('with a validated Company context it enforces THAT Company\'s package', async () => {
    const { context, reflector } = ctx(REQUIRE_MODULE_METADATA_KEY, 'logistics', { companyContext: { companyId: 'c1' } });
    const company = { isModuleEntitled: jest.fn(async () => false), isFeatureEntitled: jest.fn() };
    const guard = new RequireModuleGuard(reflector, installation(['logistics']) as never, company as never);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(NotFoundException);
    expect(company.isModuleEntitled).toHaveBeenCalledWith('c1', 'logistics');
  });

  it('allows the module when the Company\'s package includes it', async () => {
    const { context, reflector } = ctx(REQUIRE_MODULE_METADATA_KEY, 'sales', { companyContext: { companyId: 'c1' } });
    const company = { isModuleEntitled: jest.fn(async () => true), isFeatureEntitled: jest.fn() };
    const guard = new RequireModuleGuard(reflector, installation([]) as never, company as never);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('never trusts the raw JWT claim: only request.companyContext selects a Company', async () => {
    const { context, reflector } = ctx(REQUIRE_MODULE_METADATA_KEY, 'logistics', { user: { companyId: 'c1' } });
    const company = { isModuleEntitled: jest.fn(async () => false), isFeatureEntitled: jest.fn() };
    const guard = new RequireModuleGuard(reflector, installation(['logistics']) as never, company as never);
    await expect(guard.canActivate(context)).resolves.toBe(true); // installation-wide check, claim ignored
    expect(company.isModuleEntitled).not.toHaveBeenCalled();
  });

  it('is a no-op when no resolver is bound at all (pre-P3 behaviour)', async () => {
    const { context, reflector } = ctx(REQUIRE_MODULE_METADATA_KEY, 'sales', { companyContext: { companyId: 'c1' } });
    await expect(new RequireModuleGuard(reflector).canActivate(context)).resolves.toBe(true);
  });

  it('the feature guard follows the same rule', async () => {
    const { context, reflector } = ctx(REQUIRE_FEATURE_METADATA_KEY, 'accounting.fixed_assets', { companyContext: { companyId: 'c1' } });
    const denied = { isModuleEntitled: jest.fn(), isFeatureEntitled: jest.fn(async () => false) };
    await expect(new RequireFeatureGuard(reflector, installation([], ['accounting.fixed_assets']) as never, denied as never).canActivate(context)).rejects.toBeInstanceOf(NotFoundException);
    expect(denied.isFeatureEntitled).toHaveBeenCalledWith('c1', 'accounting.fixed_assets');
    const allowed = { isModuleEntitled: jest.fn(), isFeatureEntitled: jest.fn(async () => true) };
    await expect(new RequireFeatureGuard(reflector, installation([]) as never, allowed as never).canActivate(context)).resolves.toBe(true);
  });
});
