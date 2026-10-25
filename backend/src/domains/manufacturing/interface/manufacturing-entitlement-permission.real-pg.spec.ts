import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';
import { Company } from '../../../foundation/company/company.entity';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { RolePermission } from '../../../foundation/permission/role-permission.entity';
import { PERMISSION_METADATA_KEY, RequiredPermission } from '../../../foundation/permission/require-permission.decorator';
import { RequireModuleGuard, REQUIRE_MODULE_METADATA_KEY } from '../../../foundation/module-registry/require-module.decorator';
import { RequireFeatureGuard, REQUIRE_FEATURE_METADATA_KEY } from '../../../foundation/module-registry/require-feature.decorator';
import { MODULE_REGISTRY } from '../../../foundation/module-registry/module-registry';
import { manufacturingManifest } from '../../../foundation/module-registry/manifests/manufacturing.manifest';
import { MODULE_ROLE_TEMPLATES } from '../../../foundation/module-registry/role-templates';
import { CompanyPlanAssignment, Plan, PlanModule } from '../../../foundation/plans/plan.entity';
import { PlanService } from '../../../foundation/plans/plan.service';
import { CompanyPackageService } from '../../../foundation/plans/company-package.service';
import { CompanyEntitlementService } from '../../../foundation/plans/company-entitlement.service';
import { WorkCenter } from '../infrastructure/work-center.entity';
import { WorkOrderController } from './work-order.controller';
import { ManufacturingBomController } from './manufacturing-bom.controller';
import { RoutingController } from './routing.controller';
import { WorkCenterController } from './work-center.controller';
import { QuickAssemblyController } from './quick-assembly.controller';
import { WAREHOUSE_SCOPE_KEY } from '../../../foundation/scope/warehouse-scope.decorator';

/**
 * ADR-061 Addendum 1 (M6/M7, 2026-10-06) — Manufacturing uses the platform's ONE entitlement and permission
 * mechanism (Package → Entitlement → Company capability → User permission). Real PostgreSQL: two real Company
 * databases + a real control plane. Proves:
 *   - every Manufacturing route sits behind module entitlement + a registered permission node (no bypass,
 *     no second mechanism, nothing hard-coded in the pages);
 *   - the package dependency closure pulls in Manufacturing's dependencies;
 *   - a Company on a package WITHOUT manufacturing is denied (404), its neighbour with it is allowed;
 *   - downgrade blocks access without deleting data, roles or grants; upgrade restores the same data;
 *   - the per-Company permission matrix (manager / operator / viewer / none) resolves from the Company's OWN
 *     roles and never leaks between Companies.
 */
jest.setTimeout(300_000);

const ALL_MODULES = [...MODULE_REGISTRY.authoredModuleCodes()] as string[];
const manifest = manufacturingManifest;
const MANIFEST_NODES = new Set(manifest.permission_nodes.map((n) => n.node));

describe('Manufacturing — static route coverage (no unguarded or unregistered route)', () => {
  const controllers = [WorkOrderController, ManufacturingBomController, RoutingController, WorkCenterController];

  it.each(controllers.map((c) => [c.name, c] as const))('%s: class is behind @RequireModule(manufacturing) and every route has a registered permission node', (_name, ctrl) => {
    expect(Reflect.getMetadata(REQUIRE_MODULE_METADATA_KEY, ctrl)).toBe('manufacturing');
    const guards: unknown[] = Reflect.getMetadata('__guards__', ctrl) ?? [];
    expect(guards.map((g) => (g as { name: string }).name)).toEqual(expect.arrayContaining(['JwtAuthGuard', 'CompanyContextGuard', 'RequireModuleGuard']));

    const routes = Object.getOwnPropertyNames(ctrl.prototype).filter((m) => m !== 'constructor' && Reflect.getMetadata('method', ctrl.prototype[m as keyof typeof ctrl.prototype]) !== undefined);
    expect(routes.length).toBeGreaterThan(0);
    for (const m of routes) {
      const handler = ctrl.prototype[m as keyof typeof ctrl.prototype];
      const perm = Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as RequiredPermission | undefined;
      expect({ route: `${ctrl.name}.${m}`, hasPermission: !!perm }).toEqual({ route: `${ctrl.name}.${m}`, hasPermission: true });
      expect({ route: `${ctrl.name}.${m}`, nodeRegistered: MANIFEST_NODES.has(perm!.nodeKey) }).toEqual({ route: `${ctrl.name}.${m}`, nodeRegistered: true });
      const routeGuards = ((Reflect.getMetadata('__guards__', handler) ?? []) as Array<{ name: string }>).map((g) => g.name);
      expect({ route: `${ctrl.name}.${m}`, permissionGuard: routeGuards.includes('PermissionGuard') }).toEqual({ route: `${ctrl.name}.${m}`, permissionGuard: true });
      // Mutating routes need 'editable'; reads need 'read-only'.
      const verb = Reflect.getMetadata('method', handler) as number; // RequestMethod: 0 GET, 1 POST, 3 DELETE
      expect({ route: `${ctrl.name}.${m}`, access: perm!.access }).toEqual({ route: `${ctrl.name}.${m}`, access: verb === 0 ? 'read-only' : 'editable' });
    }
  });

  it('every role template grant references a registered manufacturing node; the feature is structural (follows the module entitlement)', () => {
    for (const t of MODULE_ROLE_TEMPLATES['manufacturing']) for (const g of t.grants) expect(MANIFEST_NODES.has(g.node)).toBe(true);
    expect(manifest.feature_codes).toEqual([expect.objectContaining({ code: 'manufacturing.work_orders', default: true, toggleable: false })]);
    expect(manifest.depends_on).toEqual(expect.arrayContaining(['sales', 'inventory']));
  });

  it('declares no costing/payroll/overhead surface (ADR-060 D2/D3)', () => {
    for (const n of MANIFEST_NODES) expect(n).not.toMatch(/labor|labour|overhead|standard_cost|variance|payroll/);
  });
});

describe('Manufacturing — Quick Assembly routes (UX stage 2, D8): same permission as the assembly, warehouse-scoped, idempotent confirm', () => {
  const routes = [
    ['preview', 0],
    ['assemble', 1],
  ] as const;

  it('the class is behind JWT + company + module(manufacturing) + warehouse scope guards', () => {
    expect(Reflect.getMetadata(REQUIRE_MODULE_METADATA_KEY, QuickAssemblyController)).toBe('manufacturing');
    const guards = ((Reflect.getMetadata('__guards__', QuickAssemblyController) ?? []) as Array<{ name: string }>).map((g) => g.name);
    expect(guards).toEqual(expect.arrayContaining(['JwtAuthGuard', 'CompanyContextGuard', 'RequireModuleGuard', 'WarehouseScopeGuard']));
  });

  it.each(routes)('%s needs inventory.assembly.create (editable) - never inventory stock visibility - behind PermissionGuard and a warehouse scope source', (name, verb) => {
    const handler = QuickAssemblyController.prototype[name];
    expect(Reflect.getMetadata('method', handler)).toBe(verb);
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toMatchObject({ nodeKey: 'inventory.assembly.create', access: 'editable' });
    expect(((Reflect.getMetadata('__guards__', handler) ?? []) as Array<{ name: string }>).map((g) => g.name)).toContain('PermissionGuard');
    const sources = Reflect.getMetadata(WAREHOUSE_SCOPE_KEY, handler) as Array<{ query?: string; body?: string }>;
    expect(sources).toEqual([verb === 0 ? { query: 'warehouseId' } : { body: 'warehouseId' }]);
  });
});

describe('Manufacturing — Package / Entitlement / Permission (real PostgreSQL)', () => {
  let h: TwoCompanyHarness;
  let platform: DataSource;
  let plans: PlanService;
  let packages: CompanyPackageService;
  let entitlement: CompanyEntitlementService;
  let permissions: PermissionService;
  const audit = { record: jest.fn(async () => undefined) };

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'mfg_pkg', roleModuleCodes: ['sales'], extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting', 'manufacturing'] });
    const o = h.controlPlane.options as { host: string; port: number; username: string; password: string; database: string };
    platform = new DataSource({ type: 'postgres', host: o.host, port: o.port, username: o.username, password: o.password, database: o.database, entities: [Plan, PlanModule, CompanyPlanAssignment, Company], synchronize: false, logging: false });
    await platform.initialize();
    const installation = { resolve: () => ({ status: 'active', modules: new Set(ALL_MODULES), features: new Set<string>() }) };
    entitlement = new CompanyEntitlementService(platform.getRepository(CompanyPlanAssignment), platform.getRepository(PlanModule), installation as never);
    plans = new PlanService(platform.getRepository(Plan), platform.getRepository(PlanModule), platform.getRepository(CompanyPlanAssignment), platform, installation as never, entitlement, audit as never);
    packages = new CompanyPackageService(platform.getRepository(Company), platform.getRepository(Plan), platform.getRepository(PlanModule), platform.getRepository(CompanyPlanAssignment), platform, h.connections, entitlement, installation as never, audit as never);
    permissions = new PermissionService({} as never, new AuthorizationService({} as never, {} as never));
  });

  afterAll(async () => {
    if (platform?.isInitialized) await platform.destroy();
    await h?.teardown();
  });

  async function moduleAllowed(companyId: string, moduleCode: string): Promise<boolean> {
    class C {
      h() {
        return undefined;
      }
    }
    Reflect.defineMetadata(REQUIRE_MODULE_METADATA_KEY, moduleCode, C.prototype.h);
    const installation = { isModuleEntitled: () => true, isFeatureEntitled: () => true, activeEditionCode: () => 'DAII_STANDARD' };
    const ctx = { getHandler: () => C.prototype.h, getClass: () => C, switchToHttp: () => ({ getRequest: () => ({ companyContext: { companyId } }) }) };
    try {
      return await new RequireModuleGuard(new Reflector(), installation as never, entitlement).canActivate(ctx as never);
    } catch (err) {
      if (err instanceof NotFoundException) return false;
      throw err;
    }
  }

  async function featureAllowed(companyId: string, featureCode: string): Promise<boolean> {
    class C {
      h() {
        return undefined;
      }
    }
    Reflect.defineMetadata(REQUIRE_FEATURE_METADATA_KEY, featureCode, C.prototype.h);
    const installation = { isModuleEntitled: () => true, isFeatureEntitled: () => true, activeEditionCode: () => 'DAII_STANDARD' };
    const ctx = { getHandler: () => C.prototype.h, getClass: () => C, switchToHttp: () => ({ getRequest: () => ({ companyContext: { companyId } }) }) };
    try {
      return await new RequireFeatureGuard(new Reflector(), installation as never, entitlement).canActivate(ctx as never);
    } catch (err) {
      if (err instanceof NotFoundException) return false;
      throw err;
    }
  }

  async function rolesAndGrants(companyId: string) {
    const ds = await h.connections.getDataSource(companyId);
    const roleKeys = (await ds.getRepository(Role).find()).map((r) => r.key).sort();
    const admin = await ds.getRepository(Role).findOneOrFail({ where: { key: 'admin' } });
    const adminNodes = (await ds.getRepository(RolePermission).find({ where: { roleId: admin.id } })).map((p) => p.nodeKey).sort();
    return { roleKeys, adminNodes };
  }

  it('package dependency closure: a plan of ["manufacturing"] is stored with its dependencies', async () => {
    const { plan, addedByDependency } = await plans.create({ code: 'factory', name: 'Factory', moduleCodes: ['manufacturing'] }, null);
    expect(plan.moduleCodes).toEqual(expect.arrayContaining(['manufacturing', 'sales', 'inventory']));
    expect(addedByDependency).toEqual(expect.arrayContaining(['sales', 'inventory']));
    await plans.create({ code: 'shop', name: 'Shop', moduleCodes: ['sales'] }, null);
  });

  it('Company A on "factory" is allowed Manufacturing (and its structural feature); Company B on "shop" is denied — and B gets no manufacturing roles', async () => {
    await packages.assign(h.companyAId, 'factory', null);
    await packages.assign(h.companyBId, 'shop', null);

    expect(await moduleAllowed(h.companyAId, 'manufacturing')).toBe(true);
    expect(await featureAllowed(h.companyAId, 'manufacturing.work_orders')).toBe(true);
    expect(await moduleAllowed(h.companyBId, 'manufacturing')).toBe(false);
    expect(await featureAllowed(h.companyBId, 'manufacturing.work_orders')).toBe(false);

    const a = await rolesAndGrants(h.companyAId);
    expect(a.roleKeys).toEqual(expect.arrayContaining(['manufacturing.manager', 'manufacturing.operator', 'manufacturing.viewer']));
    expect(a.adminNodes).toContain('manufacturing');
    const b = await rolesAndGrants(h.companyBId);
    expect(b.roleKeys).not.toContain('manufacturing.manager');
  });

  it('permission matrix inside Company A: manager / operator / viewer / no role resolve per the templates', async () => {
    const ds = await h.connections.getDataSource(h.companyAId);
    const users = { manager: randomUUID(), operator: randomUUID(), viewer: randomUUID(), nobody: randomUUID() };
    for (const [name, id] of Object.entries(users)) {
      await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3)`, [id, `mfg ${name}`, `mfg-${name}-${id}@test.local`]);
      if (name === 'nobody') continue;
      const role = await ds.getRepository(Role).findOneOrFail({ where: { key: `manufacturing.${name}` } });
      await ds.getRepository(UserRole).save(ds.getRepository(UserRole).create({ userId: id, roleId: role.id }));
    }
    const can = (u: string, node: string, level: 'read-only' | 'editable') => permissions.hasAtLeast(u, node, level, ds.manager);

    const ALL_WRITE = manifest.permission_nodes.map((n) => n.node).filter((n) => /\.(create|edit|delete|release|hold|complete|cancel|material_issue|material_return|finished_goods_receive|operation_execute)$/.test(n));
    // manager: everything editable
    for (const n of manifest.permission_nodes.map((x) => x.node)) expect(await can(users.manager, n, 'editable')).toBe(true);
    // viewer: reads everywhere, writes nowhere
    for (const n of ['manufacturing.work_order.view', 'manufacturing.bom.view', 'manufacturing.routing.view', 'manufacturing.work_center.view']) expect(await can(users.viewer, n, 'read-only')).toBe(true);
    for (const n of ALL_WRITE) expect(await can(users.viewer, n, 'editable')).toBe(false);
    // operator: shop-floor writes only; no master-data, no create/release/complete/cancel
    for (const n of ['manufacturing.work_order.material_issue', 'manufacturing.work_order.material_return', 'manufacturing.work_order.finished_goods_receive', 'manufacturing.work_order.operation_execute']) expect(await can(users.operator, n, 'editable')).toBe(true);
    for (const n of ['manufacturing.work_order.create', 'manufacturing.work_order.release', 'manufacturing.work_order.complete', 'manufacturing.work_order.cancel', 'manufacturing.work_order.hold', 'manufacturing.bom.create', 'manufacturing.bom.edit', 'manufacturing.routing.edit', 'manufacturing.work_center.create']) {
      expect(await can(users.operator, n, 'editable')).toBe(false);
    }
    for (const n of ['manufacturing.bom.view', 'manufacturing.routing.view', 'manufacturing.work_center.view', 'manufacturing.work_order.view']) expect(await can(users.operator, n, 'read-only')).toBe(true);
    // a user with no role sees nothing (deny by default)
    for (const n of manifest.permission_nodes.map((x) => x.node)) expect(await can(users.nobody, n, 'read-only')).toBe(false);

    // Company B's database has none of these users/roles: no leak.
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect(await permissions.resolve(users.manager, 'manufacturing.bom.view', dsB.manager)).toBe('hidden');
  });

  it('downgrade blocks access but deletes nothing; upgrade restores access to the same Manufacturing data, roles and grants', async () => {
    const ds = await h.connections.getDataSource(h.companyAId);
    await ds.query(`INSERT INTO "work_centers" ("code","name") VALUES ('SURVIVE','Survives downgrade')`);
    const wcCount = async () => (await ds.getRepository(WorkCenter).count({ where: { code: 'SURVIVE' } }));
    const before = await rolesAndGrants(h.companyAId);
    expect(await wcCount()).toBe(1);

    const down = await packages.assign(h.companyAId, 'shop', null);
    expect(down.removedModules).toEqual(expect.arrayContaining(['manufacturing']));
    expect(await moduleAllowed(h.companyAId, 'manufacturing')).toBe(false);
    expect(await featureAllowed(h.companyAId, 'manufacturing.work_orders')).toBe(false);
    expect(await wcCount()).toBe(1); // data intact
    const during = await rolesAndGrants(h.companyAId);
    expect(during.roleKeys).toEqual(expect.arrayContaining(before.roleKeys)); // roles intact
    expect(during.adminNodes).toEqual(expect.arrayContaining(before.adminNodes)); // grants intact

    const up = await packages.assign(h.companyAId, 'factory', null);
    expect(up.addedModules).toEqual(expect.arrayContaining(['manufacturing']));
    expect(await moduleAllowed(h.companyAId, 'manufacturing')).toBe(true);
    expect(await wcCount()).toBe(1); // same row, served again
  });

  it('Company B is unaffected by every change to Company A\'s package', async () => {
    expect(await moduleAllowed(h.companyBId, 'manufacturing')).toBe(false);
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect(await dsB.getRepository(WorkCenter).count()).toBe(0);
  });
});
