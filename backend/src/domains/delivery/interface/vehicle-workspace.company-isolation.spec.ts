import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { VehicleWorkspaceService } from '../application/vehicle-workspace.service';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { VehicleAccessService } from '../../shipment/application/vehicle-access.service';
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
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Vehicle Driver Workspace, Stage C / F-3, F-4, F-5 (2026-10-22) — real-Postgres proof of the single, permission-checked workspace read model:
 *  F-3 the driver's name arrives without any user-list permission; F-4 the vehicle's shipments are filtered (and scoped) on the server, newest first, with an honest `truncated` flag;
 *  F-5 collection records come back in the same response, complete for the returned shipments, and each one is shown only to who may see it (`collectionVisible`), never as zero.
 * The F-1 vehicle rule is re-proved through this endpoint, and Company B is untouched. Real default role templates are used.
 */
describe('F-3/F-4/F-5 — vehicle workspace read model — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let workspace: VehicleWorkspaceService;
  const sys = randomUUID();
  const users: Record<string, string> = {};
  const names: Record<string, string> = {};
  const ids: { v1: string; v2: string; vb: string } = { v1: '', v2: '', vb: '' };
  const sh: Record<string, string> = {};
  const dsOf = (k: 'A' | 'B') => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function userWithRole(key: string, role: string): Promise<string> {
    const ds = await dsOf('A');
    const id = randomUUID();
    names[id] = `Name of ${key}`;
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3)`, [id, names[id], `${key}-${id.slice(0, 6)}@ws.test`]);
    const r: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = $1`, [role]);
    expect(r.length).toBe(1);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3)`, [randomUUID(), id, r[0].id]);
    users[key] = id;
    return id;
  }
  async function newShipment(vehicleId: string, driverUserId: string | null, state: string, cod: string | null, ageMinutes: number, label: string) {
    const ds = await dsOf('A');
    const id = randomUUID();
    await ds.query(
      `INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","vehicleId","driverUserId","codAmount","salesOrderId","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7, now() - ($8 || ' minutes')::interval)`,
      [id, randomUUID(), `WB-${label}`, vehicleId, driverUserId, cod, randomUUID(), String(ageMinutes)],
    );
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'shipment_lifecycle','shipment',$2,$3)`, [randomUUID(), id, state]);
    sh[label] = id;
    return id;
  }
  async function addCollection(shipmentId: string, amount: string, status: 'pending' | 'remitted') {
    const ds = await dsOf('A');
    await ds.query(`INSERT INTO "collections" ("id","shipmentId","amount","method","collectorUserId","remittanceStatus") VALUES ($1,$2,$3,'cash',$4,$5)`, [randomUUID(), shipmentId, amount, sys, status]);
  }
  const get = async (k: 'A' | 'B', userId: string, vehicleId: string, limit?: number) => workspace.getWorkspace(vehicleId, userId, { limit }, (await dsOf(k)).manager);

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'f345_workspace', extraCompanyTags: ['sales', 'inventory', 'finance', 'logistics'], roleModuleCodes: ['logistics', 'finance', 'sales', 'inventory'] });
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, inert, undefined);
    const treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, inert);
    const dsA = await dsOf('A');
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const permissions = new PermissionService(dsA.getRepository(RolePermission), authorization);
    const salesOrders = { getOrderSnapshot: async (id: string) => ({ id, customerId: 'cust', totalAmount: '999.00' }) } as never;
    const customers = { getCustomerSnapshot: async () => ({ name: 'Test Customer Co', governorate: 'Cairo' }) } as never;
    const usersStub = { findByIds: async (list: string[]) => list.filter((i) => names[i]).map((i) => ({ id: i, fullName: names[i] })) } as never;
    const shipments = new ShipmentService(h.controlPlane, numbering, new ProcessEngineService(h.controlPlane), authorization, audit, inert, inventory, inert, treasury, salesOrders, customers, usersStub);
    const access = new VehicleAccessService(authorization, permissions);
    workspace = new VehicleWorkspaceService(h.controlPlane, shipments, access, authorization, permissions);

    for (const k of ['A', 'B'] as const) {
      await (await dsOf(k)).query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,'WH-MAIN','Main Warehouse','active','main')`, [randomUUID()]);
    }
    await dsA.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'system',$2) ON CONFLICT DO NOTHING`, [sys, `sys-${sys.slice(0, 6)}@ws.test`]);
    const d1 = await userWithRole('driver1', 'driver');
    const d2 = await userWithRole('driver2', 'driver');
    await userWithRole('warehouseWorker', 'warehouse_worker');
    await userWithRole('finance', 'finance');
    await userWithRole('admin', 'admin');
    await userWithRole('salesRep', 'sales_rep');
    const v1 = await shipments.createVehicle('WS-V1', 'AAA 111', d1, null, 'Cairo branch', sys, null, dsA.manager);
    const v2 = await shipments.createVehicle('WS-V2', 'BBB 222', d2, null, null, sys, null, dsA.manager);
    const vb = await shipments.createVehicle('WS-VB', 'ZZZ 999', null, null, null, sys, null, (await dsOf('B')).manager);
    ids.v1 = v1.id; ids.v2 = v2.id; ids.vb = vb.id;
    // V1: three shipments of driver1 (oldest -> newest), one of driver2 and one unassigned; V2: one of driver2
    await newShipment(v1.id, d1, 'delivered', '900.00', 50, 'd1-delivered-remitted');
    await newShipment(v1.id, d1, 'delivered', '700.00', 40, 'd1-delivered-pending');
    await newShipment(v1.id, d1, 'out_for_delivery', '500.00', 30, 'd1-out-nocollection');
    await newShipment(v1.id, d2, 'assigned', '250.00', 20, 'd2-on-v1');
    await newShipment(v1.id, null, 'created', null, 10, 'unassigned-on-v1');
    await newShipment(v2.id, d2, 'in_transit', null, 5, 'd2-on-v2');
    await addCollection(sh['d1-delivered-remitted'], '900.00', 'remitted');
    await addCollection(sh['d1-delivered-pending'], '700.00', 'pending');
    await addCollection(sh['d2-on-v1'], '100.00', 'pending');
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('F345 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  it('W1 a driver gets ONLY his own shipments of his vehicle (not the other driver\'s, not the unassigned, not another vehicle\'s), newest first, with his name and his collections', async () => {
    const w = await get('A', users.driver1, ids.v1);
    expect(w.shipments.map((s) => s.waybillNumber)).toEqual(['WB-d1-out-nocollection', 'WB-d1-delivered-pending', 'WB-d1-delivered-remitted']);
    expect(w.vehicle.driverName).toBe('Name of driver1'); // F-3: no user-list permission involved — the driver role has none
    expect(w.vehicle.branch).toBe('Cairo branch');
    const byLabel = Object.fromEntries(w.shipments.map((s) => [s.waybillNumber, s]));
    expect(byLabel['WB-d1-delivered-remitted'].collection).toMatchObject({ amount: '900.00', remittanceStatus: 'remitted' });
    expect(byLabel['WB-d1-delivered-pending'].collection).toMatchObject({ amount: '700.00', remittanceStatus: 'pending' });
    expect(byLabel['WB-d1-out-nocollection'].collection).toBeNull();
    expect(w.shipments.every((s) => s.collectionVisible)).toBe(true);
    expect(w.collectionsComplete).toBe(true);
    expect(w.truncated).toBe(false);
    expect(byLabel['WB-d1-out-nocollection'].customerName).toBe('Test Customer Co');
  });

  it('W2 a driver cannot read another vehicle\'s workspace (F-1 through this endpoint): "not found"; a user with no vehicle rights sees nothing', async () => {
    await expect(get('A', users.driver1, ids.v2)).rejects.toThrow(NotFoundException);
    await expect(get('A', users.salesRep, ids.v1)).rejects.toThrow(NotFoundException);
  });

  it('W3 a fleet reader (board_all) sees ALL shipments of THIS vehicle — server-side vehicle filter — and none of another vehicle\'s', async () => {
    const w = await get('A', users.warehouseWorker, ids.v1);
    expect(w.shipments).toHaveLength(5);
    expect(w.shipments.every((s) => s.vehicleId === ids.v1)).toBe(true);
    const w2 = await get('A', users.admin, ids.v2);
    expect(w2.shipments.map((s) => s.waybillNumber)).toEqual(['WB-d2-on-v2']);
  });

  it('W4 collections are shown only to who may see them: the warehouse worker (no collection permission, not the driver) gets collectionVisible=false — never an empty record — and collectionsComplete=false; finance and admin see all', async () => {
    const ww = await get('A', users.warehouseWorker, ids.v1);
    expect(ww.shipments.every((s) => s.collectionVisible === false && s.collection === null)).toBe(true);
    expect(ww.collectionsComplete).toBe(false);
    for (const u of ['finance', 'admin']) {
      const w = await get('A', users[u], ids.v1);
      expect({ u, complete: w.collectionsComplete }).toEqual({ u, complete: true });
      const d2 = w.shipments.find((s) => s.waybillNumber === 'WB-d2-on-v1')!;
      expect(d2.collection).toMatchObject({ amount: '100.00', remittanceStatus: 'pending' });
      expect(w.shipments.find((s) => s.waybillNumber === 'WB-unassigned-on-v1')!.collection).toBeNull();
    }
  });

  it('W5 the list is capped and says so: limit=2 returns the 2 newest with truncated=true; the exact limit is not "truncated"', async () => {
    const w = await get('A', users.admin, ids.v1, 2);
    expect(w.shipments.map((s) => s.waybillNumber)).toEqual(['WB-unassigned-on-v1', 'WB-d2-on-v1']);
    expect(w.truncated).toBe(true);
    expect((await get('A', users.admin, ids.v1, 5)).truncated).toBe(false);
  });

  it('W6 states come from the process instances in one batch and equal the shipment\'s own state; the overview carries the Treasury custody balance and the active count', async () => {
    const w = await get('A', users.admin, ids.v1);
    const state = Object.fromEntries(w.shipments.map((s) => [s.waybillNumber, s.state]));
    expect(state).toMatchObject({ 'WB-d1-delivered-remitted': 'delivered', 'WB-d1-out-nocollection': 'out_for_delivery', 'WB-d2-on-v1': 'assigned', 'WB-unassigned-on-v1': 'created' });
    expect(w.overview.custodyBalance).toBe('0.00');
    expect(w.overview.activeShipmentsCount).toBe(3);
  });

  it('W7 Company isolation: through Company B nothing of Company A is visible, and a Company A vehicle id is "not found" there', async () => {
    await expect(get('B', users.admin, ids.v1)).rejects.toThrow(NotFoundException);
    await expect(get('B', users.driver1, ids.vb)).rejects.toThrow(NotFoundException);
    const b = await (await dsOf('B')).query(`SELECT count(*)::int AS n FROM "shipments"`);
    expect(b[0].n).toBe(0);
  });
});
