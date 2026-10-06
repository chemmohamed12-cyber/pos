import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { Company } from '../company/company.entity';
import { Role } from '../authorization/role.entity';
import { RolePermission } from '../permission/role-permission.entity';
import { RequireModuleGuard, REQUIRE_MODULE_METADATA_KEY } from '../module-registry/require-module.decorator';
import { MODULE_REGISTRY } from '../module-registry/module-registry';
import { Reflector } from '@nestjs/core';
import { CompanyPlanAssignment, Plan, PlanModule } from './plan.entity';
import { PlanService } from './plan.service';
import { CompanyPackageService } from './company-package.service';
import { CompanyEntitlementService } from './company-entitlement.service';

/**
 * Company Plans / Packages — REAL PostgreSQL proof (two real Company databases
 * + a real control plane, all disposable `daii_test_plans_*` databases created
 * and dropped by the harness; point DB_HOST/DB_PORT at the isolated instance).
 *
 * Proves what the unit specs only mock: the package really lands in the
 * platform DB, assignment prepares the Company's OWN database (roles + admin
 * grants), enforcement follows the validated Company, a downgrade removes access
 * but never deletes roles/grants, and one Company's package never leaks to the
 * other.
 */
jest.setTimeout(240_000);

const ALL_MODULES = [...MODULE_REGISTRY.authoredModuleCodes()] as string[];

describe('Company Plans / Packages — real PostgreSQL', () => {
  let h: TwoCompanyHarness;
  let platform: DataSource;
  let plans: PlanService;
  let packages: CompanyPackageService;
  let entitlement: CompanyEntitlementService;
  const audit = { record: jest.fn(async () => undefined) };

  beforeAll(async () => {
    // roleModuleCodes ['sales'] = the Company starts with only the sales role templates, like a bare Company.
    h = await setUpTwoCompanyHarness({ namePrefix: 'plans', roleModuleCodes: ['sales'], extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    platform = new DataSource({
      type: 'postgres',
      host: (h.controlPlane.options as { host: string }).host,
      port: (h.controlPlane.options as { port: number }).port,
      username: (h.controlPlane.options as { username: string }).username,
      password: (h.controlPlane.options as { password: string }).password,
      database: (h.controlPlane.options as { database: string }).database,
      entities: [Plan, PlanModule, CompanyPlanAssignment, Company],
      synchronize: false,
      logging: false,
    });
    await platform.initialize();
    const installation = { resolve: () => ({ status: 'active', modules: new Set(ALL_MODULES), features: new Set<string>() }) };
    entitlement = new CompanyEntitlementService(platform.getRepository(CompanyPlanAssignment), platform.getRepository(PlanModule), installation as never);
    plans = new PlanService(platform.getRepository(Plan), platform.getRepository(PlanModule), platform.getRepository(CompanyPlanAssignment), platform, installation as never, entitlement, audit as never);
    packages = new CompanyPackageService(
      platform.getRepository(Company),
      platform.getRepository(Plan),
      platform.getRepository(PlanModule),
      platform.getRepository(CompanyPlanAssignment),
      platform,
      h.connections,
      entitlement,
      installation as never,
      audit as never,
    );
  });

  afterAll(async () => {
    if (platform?.isInitialized) await platform.destroy();
    await h?.teardown();
  });

  async function companyRoleState(companyId: string): Promise<{ roleKeys: string[]; adminNodes: string[] }> {
    const ds = await h.connections.getDataSource(companyId);
    const roleKeys = (await ds.getRepository(Role).find()).map((r) => r.key).sort();
    const admin = await ds.getRepository(Role).findOneOrFail({ where: { key: 'admin' } });
    const adminNodes = (await ds.getRepository(RolePermission).find({ where: { roleId: admin.id } })).map((p) => p.nodeKey).sort();
    return { roleKeys, adminNodes };
  }

  async function guardAllows(companyId: string | null, moduleCode: string): Promise<boolean> {
    class C {
      h() {
        return undefined;
      }
    }
    Reflect.defineMetadata(REQUIRE_MODULE_METADATA_KEY, moduleCode, C.prototype.h);
    const installation = { isModuleEntitled: () => true, isFeatureEntitled: () => true, activeEditionCode: () => 'DAII_STANDARD' };
    const guard = new RequireModuleGuard(new Reflector(), installation as never, entitlement);
    const ctx = {
      getHandler: () => C.prototype.h,
      getClass: () => C,
      switchToHttp: () => ({ getRequest: () => (companyId ? { companyContext: { companyId } } : {}) }),
    };
    try {
      return await guard.canActivate(ctx as never);
    } catch (err) {
      if (err instanceof NotFoundException) return false;
      throw err;
    }
  }

  it('creates plans with their dependency closure stored expanded', async () => {
    const { plan, addedByDependency } = await plans.create({ code: 'commerce', name: 'Commerce', moduleCodes: ['sales'] }, null);
    expect(plan.moduleCodes).toEqual(['accounting', 'finance', 'inventory', 'sales']);
    expect(addedByDependency).toEqual(['accounting', 'finance', 'inventory']);
    const people = await plans.create({ code: 'people', name: 'People', moduleCodes: ['hr'] }, null);
    expect(people.plan.moduleCodes).toEqual(['hr']);
  });

  it('a Company with no package inherits the installation entitlement; the other is untouched by assignments', async () => {
    expect(await guardAllows(h.companyAId, 'logistics')).toBe(true);
    expect(await guardAllows(h.companyBId, 'logistics')).toBe(true);
  });

  it('assigning a package enforces it for THAT Company only and prepares its own database', async () => {
    const before = await companyRoleState(h.companyAId);
    // (the admin role already holds broad module nodes from the core grant migrations; what a package adds is the module role templates)
    expect(before.roleKeys).not.toContain('accounting.manager');
    expect(before.roleKeys).toContain('sales.manager');

    const res = await packages.assign(h.companyAId, 'commerce', null);
    expect(res.rolesSynced).toBe(true);
    expect(res.package.source).toBe('package');
    expect(res.package.effectiveModules).toEqual(['accounting', 'finance', 'inventory', 'sales']);
    // it went from "everything licensed" down to the package: a downgrade, reported as such
    expect(res.removedModules).toEqual(expect.arrayContaining(['hr', 'logistics', 'payroll']));
    expect(res.addedModules).toEqual([]);

    // enforcement follows the validated Company id
    expect(await guardAllows(h.companyAId, 'sales')).toBe(true);
    expect(await guardAllows(h.companyAId, 'logistics')).toBe(false);
    expect(await guardAllows(h.companyAId, 'hr')).toBe(false);
    // the other Company never saw A's package
    expect(await guardAllows(h.companyBId, 'logistics')).toBe(true);
    expect(await guardAllows(h.companyBId, 'hr')).toBe(true);
    // a request without a validated Company context keeps the installation-wide answer
    expect(await guardAllows(null, 'logistics')).toBe(true);

    // Company A's OWN database now has the package modules' admin grants and role templates; B's does not
    const after = await companyRoleState(h.companyAId);
    expect(after.adminNodes).toEqual(expect.arrayContaining(['sales', 'inventory', 'finance', 'accounting']));
    expect(res.rolesAdded).toBeGreaterThan(0);
    expect(after.roleKeys).toEqual(expect.arrayContaining(['inventory.manager', 'finance.manager', 'accounting.manager']));
    const b = await companyRoleState(h.companyBId);
    expect(b.roleKeys).not.toContain('accounting.manager');
    expect(b.roleKeys).not.toContain('inventory.manager');
  });

  it('a downgrade removes access immediately but never deletes the Company\'s roles or grants', async () => {
    const res = await packages.assign(h.companyAId, 'people', null);
    expect(res.package.effectiveModules).toEqual(['hr']);
    expect(res.removedModules).toEqual(['accounting', 'finance', 'inventory', 'sales']);
    expect(res.addedModules).toEqual(['hr']);
    expect(await guardAllows(h.companyAId, 'sales')).toBe(false);
    expect(await guardAllows(h.companyAId, 'hr')).toBe(true);
    const state = await companyRoleState(h.companyAId);
    expect(state.adminNodes).toEqual(expect.arrayContaining(['sales', 'accounting', 'hr'])); // previous grants kept
    expect(state.roleKeys).toEqual(expect.arrayContaining(['accounting.manager']));
  });

  it('Area 21: business data written under a module survives a downgrade untouched and is served again on re-upgrade (package change never deletes data)', async () => {
    await packages.assign(h.companyAId, 'commerce', null); // upgrade: accounting is back
    expect(await guardAllows(h.companyAId, 'accounting')).toBe(true);
    const ds = await h.connections.getDataSource(h.companyAId);
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive") VALUES (gen_random_uuid(),'7777','Survives downgrade','asset','debit',true,true,true)`,
    );
    const count = async () => (await ds.query(`SELECT count(*)::int n FROM accounting_gl_accounts WHERE code = '7777'`))[0].n;
    expect(await count()).toBe(1);

    await packages.assign(h.companyAId, 'people', null); // downgrade: accounting access is gone …
    expect(await guardAllows(h.companyAId, 'accounting')).toBe(false);
    expect(await count()).toBe(1); // … the data is not

    await packages.assign(h.companyAId, 'commerce', null); // reactivation: same data, access restored
    expect(await guardAllows(h.companyAId, 'accounting')).toBe(true);
    expect(await count()).toBe(1);

    await packages.assign(h.companyAId, 'people', null); // leave Company A as the following tests expect it
  });

  it('editing a plan applies immediately to every Company on it and reports the change', async () => {
    await packages.assign(h.companyBId, 'commerce', null);
    expect(await guardAllows(h.companyBId, 'logistics')).toBe(false);
    const up = await plans.update('commerce', { moduleCodes: ['logistics'] }, null);
    expect(up.plan.moduleCodes).toEqual(['accounting', 'finance', 'inventory', 'logistics', 'sales']);
    expect(up.addedModules).toEqual(['logistics']);
    expect(up.removedModules).toEqual([]);
    expect(up.affectedCompanyIds).toEqual([h.companyBId]);
    expect(await guardAllows(h.companyBId, 'logistics')).toBe(true); // cache was invalidated
    const down = await plans.update('commerce', { moduleCodes: ['sales'] }, null);
    expect(down.removedModules).toEqual(['logistics']);
    expect(await guardAllows(h.companyBId, 'logistics')).toBe(false);
    // Company A (on a different plan) was never affected
    expect(await guardAllows(h.companyAId, 'hr')).toBe(true);
  });

  it('refuses to assign an archived plan, an unknown plan and an unknown company', async () => {
    await plans.update('people', { status: 'archived' }, null);
    await expect(packages.assign(h.companyBId, 'people', null)).rejects.toThrow(/archived/);
    await expect(packages.assign(h.companyBId, 'nope', null)).rejects.toThrow(/not found/i);
    await expect(packages.assign('00000000-0000-4000-8000-000000000000', 'commerce', null)).rejects.toThrow(/not found/i);
    // an archived plan keeps working for the Company already on it
    expect(await guardAllows(h.companyAId, 'hr')).toBe(true);
  });
});
