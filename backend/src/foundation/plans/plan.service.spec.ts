import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { MODULE_REGISTRY } from '../module-registry/module-registry';
import { PLAN_CODE_PATTERN, PlanService } from './plan.service';

function service(licensed: string[], status: 'active' | 'expired' = 'active') {
  const installation = { resolve: () => ({ status, modules: new Set(licensed) }) };
  return new PlanService(null as never, null as never, null as never, null as never, installation as never, null as never, null as never);
}

const ALL = [...MODULE_REGISTRY.authoredModuleCodes()] as string[];

describe('PlanService — closure and licence ceiling', () => {
  it('expands the dependency closure (the sales/inventory/finance/accounting cycle) and reports what it added', () => {
    const { moduleCodes, added } = service(ALL).closeAndValidate(['sales']);
    expect(moduleCodes).toEqual(['accounting', 'finance', 'inventory', 'sales']);
    expect(added).toEqual(['accounting', 'finance', 'inventory']);
  });

  it('keeps an independent module independent (hr has no dependencies)', () => {
    expect(service(ALL).closeAndValidate(['hr']).moduleCodes).toEqual(['hr']);
  });

  it('pulls in everything a heavy module needs (payroll)', () => {
    const { moduleCodes } = service(ALL).closeAndValidate(['payroll']);
    expect(moduleCodes).toEqual(expect.arrayContaining(['payroll', 'hr', 'attendance', 'commission', 'targets', 'finance', 'sales']));
  });

  it('rejects an empty selection and unknown modules', () => {
    expect(() => service(ALL).closeAndValidate([])).toThrow(BadRequestException);
    expect(() => service(ALL).closeAndValidate(['sales', 'warp-drive'])).toThrow(/Unknown module/);
  });

  it('rejects a module the installation licence does not include — including one pulled in by closure', () => {
    // licence has sales but not its dependencies → the closed set is not fully licensed
    expect(() => service(['sales']).closeAndValidate(['sales'])).toThrow(UnprocessableEntityException);
    expect(() => service(['hr']).closeAndValidate(['payroll'])).toThrow(/licence does not include/);
  });

  it('refuses everything when the installation licence is not active', () => {
    expect(() => service(ALL, 'expired').closeAndValidate(['hr'])).toThrow(UnprocessableEntityException);
  });

  it('moduleCatalog marks licensed modules and exposes dependency data', () => {
    const catalog = service(['hr', 'sales']).moduleCatalog();
    expect(catalog.find((m) => m.code === 'hr')).toMatchObject({ licensed: true, dependsOn: [], closure: [] });
    expect(catalog.find((m) => m.code === 'payroll')?.licensed).toBe(false);
    expect(catalog.length).toBe(ALL.length);
  });

  it('plan codes are lowercase slugs', () => {
    expect(PLAN_CODE_PATTERN.test('commerce-core')).toBe(true);
    expect(PLAN_CODE_PATTERN.test('Commerce Core')).toBe(false);
    expect(PLAN_CODE_PATTERN.test('x')).toBe(false);
  });
});
