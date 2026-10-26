import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { ShipmentController } from './shipment.controller';
import { ShipmentService } from '../application/shipment.service';
import { VehicleAccessService } from '../application/vehicle-access.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { RolePermission } from '../../../foundation/permission/role-permission.entity';
import { OrganizationService } from '../../../foundation/organization/organization.service';
import { AccessScope, AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { OrgContextService } from '../../../foundation/scope/org-context.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';
import type { CompanyScopedRequest } from '../../../foundation/company/company-context.guard';

/**
 * Vehicle Driver Workspace, Stage C / F-1 (2026-10-22) — real-Postgres proof of the server-side rule on the vehicle READ endpoints (list, vehicle overview, shipping-company overview):
 * a driver sees and reads only the vehicles he is the assigned driver of — by URL or by direct API call alike — while every role that legitimately works with vehicles and custody keeps
 * its access (they are exercised with the REAL default role templates of the product, not stand-ins), and Company B is untouched. A denied read is answered "not found".
 */
describe('F-1 — vehicle read access is enforced on the server (list / overview) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let controllerOf: (k: 'A' | 'B') => Promise<ShipmentController>;
  let shipments: ShipmentService;
  const sys = randomUUID();
  const unrestricted = (): AccessScope => ({ userId: sys, unrestricted: true, unitIds: new Set<string>() });
  const restrictedTo = (...units: string[]): AccessScope => ({ userId: sys, unrestricted: false, unitIds: new Set(units) });
  let scope: AccessScope = unrestricted();
  const users: Record<string, string> = {};
  const vehicles: Record<string, { id: string; driverUserId: string | null }> = {};
  let companyOverviewId = '';
  const dsOf = (k: 'A' | 'B') => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function userWithRoles(key: string, roles: string[]): Promise<string> {
    const ds = await dsOf('A');
    const id = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3)`, [id, key, `${key}-${id.slice(0, 6)}@vehicle-access.test`]);
    for (const roleKey of roles) {
      const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = $1`, [roleKey]);
      expect(role.length).toBe(1); // the REAL default template role must exist in the Company database
      await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3)`, [randomUUID(), id, role[0].id]);
    }
    users[key] = id;
    return id;
  }
  const reqOf = async (k: 'A' | 'B', userId: string) => ({ user: { id: userId }, companyContext: { dataSource: await dsOf(k) } }) as unknown as CompanyScopedRequest;
  const listIds = async (k: 'A' | 'B', userId: string) => ((await (await controllerOf(k)).listVehicles(await reqOf(k, userId))) as Array<{ id: string }>).map((v) => v.id).sort();

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'f1_vehicle_access', extraCompanyTags: ['sales', 'inventory', 'finance', 'logistics'], roleModuleCodes: ['logistics', 'finance', 'sales', 'inventory'] });
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, inert, undefined);
    const treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, inert);
    const dsA = await dsOf('A');
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const permissions = new PermissionService(dsA.getRepository(RolePermission), authorization);
    shipments = new ShipmentService(h.controlPlane, numbering, new ProcessEngineService(h.controlPlane), authorization, audit, inert, inventory, inert, treasury, inert, inert, inert);
    const access = new VehicleAccessService(authorization, permissions);
    const scopes = new AccessScopeService(inert, inert);
    jest.spyOn(scopes, 'forRequest').mockImplementation(async () => scope);
    controllerOf = async () => new ShipmentController(shipments, access, new OrgContextService(scopes));

    for (const k of ['A', 'B'] as const) {
      const ds = await dsOf(k);
      await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,'WH-MAIN','Main Warehouse','active','main')`, [randomUUID()]);
    }
    await ds0(dsA);
  });

  async function ds0(dsA: Awaited<ReturnType<typeof dsOf>>) {
    await dsA.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'system',$2) ON CONFLICT DO NOTHING`, [sys, `sys-${sys.slice(0, 6)}@vehicle-access.test`]);
    const driver1 = await userWithRoles('driver1', ['driver']);
    const driver2 = await userWithRoles('driver2', ['driver']);
    await userWithRoles('driverNoVehicle', ['driver']);
    await userWithRoles('warehouseWorker', ['warehouse_worker']);
    await userWithRoles('finance', ['finance']);
    await userWithRoles('dispatcher', ['logistics.dispatcher']);
    await userWithRoles('logisticsViewer', ['logistics.viewer']);
    await userWithRoles('logisticsManager', ['logistics.manager']);
    await userWithRoles('admin', ['admin']);
    await userWithRoles('salesRep', ['sales_rep']);
    await userWithRoles('noRoles', []);
    const svc = shipments;
    const v1 = await svc.createVehicle('F1-V1', 'AAA 111', driver1, null, 'Cairo', sys, null, dsA.manager);
    const v2 = await svc.createVehicle('F1-V2', 'BBB 222', driver2, null, 'Alexandria', sys, null, dsA.manager);
    const v3 = await svc.createVehicle('F1-V3', 'CCC 333', null, null, null, sys, null, dsA.manager);
    vehicles.v1 = { id: v1.id, driverUserId: driver1 };
    vehicles.v2 = { id: v2.id, driverUserId: driver2 };
    vehicles.v3 = { id: v3.id, driverUserId: null };
    const dsB = await dsOf('B');
    const vb = await svc.createVehicle('F1-VB', 'BBB 999', null, null, null, sys, null, dsB.manager);
    vehicles.vb = { id: vb.id, driverUserId: null };
    const company = await svc.createShippingCompany('F1-CO', 'F1 Carrier', null, null, null, sys, null, dsA.manager);
    companyOverviewId = company.id;
  }

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('F1 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  const all = () => [vehicles.v1.id, vehicles.v2.id, vehicles.v3.id].sort();
  const overview = async (userId: string, vehicleId: string) => (await controllerOf('A')).getVehicleOverview(await reqOf('A', userId), vehicleId);

  it('V1 a driver sees ONLY the vehicle he is assigned to (list) and can read only its overview — another driver\'s vehicle and an unassigned one are "not found"', async () => {
    expect(await listIds('A', users.driver1)).toEqual([vehicles.v1.id]);
    expect(await listIds('A', users.driver2)).toEqual([vehicles.v2.id]);
    const own = await overview(users.driver1, vehicles.v1.id);
    expect(own.custodyAccountId).toBe((await shipments.getVehicle(vehicles.v1.id, (await dsOf('A')).manager)).custodyAccountId);
    expect(own.custodyBalance).toBe('0.00');
    await expect(overview(users.driver1, vehicles.v2.id)).rejects.toThrow(NotFoundException);
    await expect(overview(users.driver1, vehicles.v3.id)).rejects.toThrow(NotFoundException);
    await expect(overview(users.driver2, vehicles.v1.id)).rejects.toThrow(NotFoundException);
  });

  it('V2 a driver with no vehicle, a sales rep and a user with no role see nothing (empty list, overview "not found")', async () => {
    for (const u of [users.driverNoVehicle, users.salesRep, users.noRoles]) {
      expect(await listIds('A', u)).toEqual([]);
      await expect(overview(u, vehicles.v1.id)).rejects.toThrow(NotFoundException);
    }
  });

  it('V3 every role that legitimately works with vehicles keeps FULL access: warehouse worker, finance, dispatcher, logistics viewer/manager, admin', async () => {
    for (const u of ['warehouseWorker', 'finance', 'dispatcher', 'logisticsViewer', 'logisticsManager', 'admin']) {
      expect({ role: u, ids: await listIds('A', users[u]) }).toEqual({ role: u, ids: all() });
      for (const v of [vehicles.v1, vehicles.v2, vehicles.v3]) expect((await overview(users[u], v.id)).warehouseId).not.toBeUndefined();
    }
  });

  it('V4 a shipping company\'s overview is for fleet readers only — a driver gets "not found"', async () => {
    const c = await controllerOf('A');
    await expect(c.getShippingCompanyOverview(await reqOf('A', users.driver1), companyOverviewId)).rejects.toThrow(NotFoundException);
    await expect(c.getShippingCompanyOverview(await reqOf('A', users.salesRep), companyOverviewId)).rejects.toThrow(NotFoundException);
    expect((await c.getShippingCompanyOverview(await reqOf('A', users.warehouseWorker), companyOverviewId)).activeShipmentsCount).toBe(0);
    expect((await c.getShippingCompanyOverview(await reqOf('A', users.admin), companyOverviewId)).activeShipmentsCount).toBe(0);
  });

  it('V5 a custom role granted the `logistics.vehicle.view` node becomes a fleet reader (the permission path), and loses it when the grant is removed', async () => {
    const ds = await dsOf('A');
    const roleId = randomUUID();
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'f1_custom_viewer')`, [roleId]);
    const uid = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'custom',$2)`, [uid, `custom-${uid.slice(0, 6)}@vehicle-access.test`]);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3)`, [randomUUID(), uid, roleId]);
    expect(await listIds('A', uid)).toEqual([]);
    await ds.query(`INSERT INTO "role_permissions" ("id","roleId","nodeKey","access") VALUES ($1,$2,'logistics.vehicle.view','read-only')`, [randomUUID(), roleId]);
    expect(await listIds('A', uid)).toEqual(all());
    await ds.query(`DELETE FROM "role_permissions" WHERE "roleId" = $1`, [roleId]);
    expect(await listIds('A', uid)).toEqual([]);
  });

  it('V6 Company isolation: Company A\'s driver reading through Company B sees nothing and cannot read B\'s vehicle; Company B\'s vehicle never appears in A', async () => {
    expect(await listIds('B', users.driver1)).toEqual([]);
    const c = await controllerOf('B');
    await expect(c.getVehicleOverview(await reqOf('B', users.driver1), vehicles.vb.id)).rejects.toThrow(NotFoundException);
    expect(await listIds('A', users.admin)).not.toContain(vehicles.vb.id);
    await expect((await controllerOf('A')).getVehicleOverview(await reqOf('A', users.admin), vehicles.vb.id)).rejects.toThrow(NotFoundException);
  });

  // ---- Integration (trial branch integration/vw-org-on-1.1.12): the org-engine branch scope AND the F-1 access rule hold TOGETHER on the vehicle list / overview ----
  describe('I - branch scope AND F-1 access rule together', () => {
    const ids: Record<string, string> = {};
    beforeAll(async () => {
      const dsA = await dsOf('A');
      const org = new OrganizationService(dsA);
      ids.root = (await org.createUnit('company', 'INT Mother')).id;
      ids.cairo = (await org.createUnit('branch', 'INT Cairo', ids.root)).id;
      ids.tanta = (await org.createUnit('branch', 'INT Tanta', ids.root)).id;
      await dsA.query(`UPDATE "vehicles" SET "orgUnitId" = $1 WHERE id = $2`, [ids.cairo, vehicles.v1.id]); // driver1's vehicle: Cairo
      await dsA.query(`UPDATE "vehicles" SET "orgUnitId" = $1 WHERE id = $2`, [ids.tanta, vehicles.v2.id]); // driver2's vehicle: Tanta
      // v3 stays UNLINKED (legacy): visible by the org rule to everyone, so only the F-1 rule applies
    });
    afterEach(() => {
      scope = unrestricted();
    });

    it('I1 a fleet reader restricted to Tanta sees only the Tanta vehicle and the legacy (unlinked) one - NOT Cairo\'s (org scope), although a fleet reader would otherwise see all', async () => {
      scope = restrictedTo(ids.tanta);
      expect(await listIds('A', users.admin)).toEqual([vehicles.v2.id, vehicles.v3.id].sort());
      await expect(overview(users.admin, vehicles.v1.id)).rejects.toThrow(NotFoundException);
      expect((await overview(users.admin, vehicles.v2.id)).warehouseId).not.toBeUndefined();
    });

    it('I2 the F-1 rule is not weakened by the org scope: an UNRESTRICTED driver still sees only his own vehicle; an unrestricted fleet reader sees all three', async () => {
      scope = unrestricted();
      expect(await listIds('A', users.driver1)).toEqual([vehicles.v1.id]);
      await expect(overview(users.driver1, vehicles.v2.id)).rejects.toThrow(NotFoundException);
      expect(await listIds('A', users.admin)).toEqual(all());
    });

    it('I3 the org rule is not weakened by being the assigned driver: driver1 (Cairo vehicle) whose scope reaches only Tanta gets "not found" for his own out-of-scope vehicle (both rules must pass)', async () => {
      scope = restrictedTo(ids.tanta);
      expect(await listIds('A', users.driver1)).toEqual([]);
      await expect(overview(users.driver1, vehicles.v1.id)).rejects.toThrow(NotFoundException);
      scope = restrictedTo(ids.cairo);
      expect(await listIds('A', users.driver1)).toEqual([vehicles.v1.id]);
      expect((await overview(users.driver1, vehicles.v1.id)).warehouseId).not.toBeUndefined();
    });

    it('I4 a user with neither right (sales rep) sees nothing under any scope; a legacy unlinked vehicle is subject to the F-1 rule only', async () => {
      scope = restrictedTo(ids.cairo);
      expect(await listIds('A', users.salesRep)).toEqual([]);
      expect(await listIds('A', users.warehouseWorker)).toEqual([vehicles.v1.id, vehicles.v3.id].sort());
    });
  });
});
