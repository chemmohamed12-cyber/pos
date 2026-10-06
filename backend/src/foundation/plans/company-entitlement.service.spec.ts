import { CompanyEntitlementService } from './company-entitlement.service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function make(opts: {
  installation?: { status: 'active' | 'suspended' | 'expired'; modules: string[]; features?: string[] };
  assignments?: Record<string, string>; // companyId -> planCode
  planModules?: Record<string, string[]>; // planCode -> modules
}) {
  const given = opts.installation ?? { status: 'active' as const, modules: ['sales', 'inventory', 'finance', 'accounting', 'logistics', 'hr'] };
  const inst: { status: 'active' | 'suspended' | 'expired'; modules: string[]; features: string[] } = { features: [], ...given };
  const installation = { resolve: () => ({ status: inst.status, modules: new Set(inst.modules), features: new Set(inst.features) }) };
  const assignmentFind = jest.fn(async ({ where }: { where: { companyId: string } }) => {
    const planCode = opts.assignments?.[where.companyId];
    return planCode ? { companyId: where.companyId, planCode } : null;
  });
  const planModulesFind = jest.fn(async ({ where }: { where: { planCode: string } }) => (opts.planModules?.[where.planCode] ?? []).map((moduleCode) => ({ planCode: where.planCode, moduleCode })));
  const svc = new CompanyEntitlementService({ findOne: assignmentFind } as never, { find: planModulesFind } as never, installation as never);
  return { svc, assignmentFind };
}

describe('CompanyEntitlementService', () => {
  it('a Company with no package inherits the installation entitlement unchanged', async () => {
    const { svc } = make({});
    const r = await svc.resolve(A);
    expect(r.source).toBe('installation');
    expect(r.planCode).toBeNull();
    expect(await svc.isModuleEntitled(A, 'logistics')).toBe(true);
    expect(await svc.isModuleEntitled(A, 'payroll')).toBe(false); // not licensed by the installation
  });

  it('an assigned package is enforced: only its modules are entitled', async () => {
    const { svc } = make({ assignments: { [A]: 'commerce' }, planModules: { commerce: ['sales', 'inventory', 'finance', 'accounting'] } });
    expect((await svc.resolve(A)).source).toBe('package');
    expect(await svc.isModuleEntitled(A, 'sales')).toBe(true);
    expect(await svc.isModuleEntitled(A, 'logistics')).toBe(false); // licensed, but not in the package
    expect(await svc.isModuleEntitled(A, 'hr')).toBe(false);
  });

  it('the installation licence is a ceiling: a package can never grant an unlicensed module', async () => {
    const { svc } = make({ installation: { status: 'active', modules: ['sales', 'inventory'] }, assignments: { [A]: 'big' }, planModules: { big: ['sales', 'inventory', 'payroll'] } });
    expect(await svc.isModuleEntitled(A, 'sales')).toBe(true);
    expect(await svc.isModuleEntitled(A, 'payroll')).toBe(false);
  });

  it('an expired/suspended installation licence yields nothing for any Company (core stays available)', async () => {
    const { svc } = make({ installation: { status: 'expired', modules: ['sales'] }, assignments: { [A]: 'p' }, planModules: { p: ['sales'] } });
    expect(await svc.isModuleEntitled(A, 'sales')).toBe(false);
    expect(await svc.isModuleEntitled(A, 'core')).toBe(true);
  });

  it('keeps two Companies strictly separate (no shared "current company")', async () => {
    const { svc } = make({ assignments: { [A]: 'commerce', [B]: 'people' }, planModules: { commerce: ['sales'], people: ['hr'] } });
    expect(await svc.isModuleEntitled(A, 'sales')).toBe(true);
    expect(await svc.isModuleEntitled(A, 'hr')).toBe(false);
    expect(await svc.isModuleEntitled(B, 'hr')).toBe(true);
    expect(await svc.isModuleEntitled(B, 'sales')).toBe(false);
  });

  it('caches per Company and invalidates exactly', async () => {
    const { svc, assignmentFind } = make({ assignments: { [A]: 'commerce' }, planModules: { commerce: ['sales'] } });
    await svc.resolve(A);
    await svc.resolve(A);
    expect(assignmentFind).toHaveBeenCalledTimes(1);
    svc.invalidate(B); // another Company: no effect
    await svc.resolve(A);
    expect(assignmentFind).toHaveBeenCalledTimes(1);
    svc.invalidate(A);
    await svc.resolve(A);
    expect(assignmentFind).toHaveBeenCalledTimes(2);
    svc.invalidate(); // everything
    await svc.resolve(A);
    expect(assignmentFind).toHaveBeenCalledTimes(3);
  });

  it('features follow the package: restricted to its modules, structural features follow their module', async () => {
    const { svc } = make({
      installation: { status: 'active', modules: ['sales', 'accounting'], features: ['sales.catalog', 'accounting.chart_of_accounts', 'accounting.financial_dimensions'] },
      assignments: { [A]: 'p' },
      planModules: { p: ['sales'] },
    });
    expect(await svc.isFeatureEntitled(A, 'sales.catalog')).toBe(true);
    expect(await svc.isFeatureEntitled(A, 'accounting.financial_dimensions')).toBe(false);
  });
});
