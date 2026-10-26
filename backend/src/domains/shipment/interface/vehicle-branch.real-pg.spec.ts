import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ShipmentService } from '../application/shipment.service';
import { ShipmentController } from './shipment.controller';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { OrganizationService } from '../../../foundation/organization/organization.service';
import { AccessScope, AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { OrgContextService } from '../../../foundation/scope/org-context.service';
import { VehicleAccessService } from '../application/vehicle-access.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { RolePermission } from '../../../foundation/permission/role-permission.entity';
import { CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Org engine Stage 2 (real PostgreSQL) — the vehicle's branch is a validated organizational reference, resolved on the server: required once the Company has active
 * branches, validated (exists in THIS Company, active, type branch, inside the caller's scope), inherited by the custody sub-location and the custody treasury
 * account, and a Company without branches keeps working exactly as before. The legacy free text is never auto-mapped.
 */
describe('Vehicle branch — validated organizational reference (real Postgres)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let dsA: DataSource;
  let dsB: DataSource;
  let controller: ShipmentController;
  let service: ShipmentService;
  let scope: AccessScope;
  const ids: Record<string, string> = {};
  const userId = randomUUID();

  const req = (ds: DataSource) => ({ user: { id: userId, email: 'x@test.local', companyId: 'c' }, companyContext: { companyId: 'c', dataSource: ds } }) as unknown as CompanyScopedRequest;
  const unrestricted = (): AccessScope => ({ userId, unrestricted: true, unitIds: new Set<string>() });
  const restrictedTo = (...units: string[]): AccessScope => ({ userId, unrestricted: false, unitIds: new Set(units) });
  const q = async (ds: DataSource, sql: string, p: unknown[] = []) => ds.query(sql, p);

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'vehicle_branch', extraCompanyTags: ['sales', 'inventory', 'finance', 'logistics'] });
    dsA = await h.connections.getDataSource(h.companyAId);
    dsB = await h.connections.getDataSource(h.companyBId);
    for (const ds of [dsA, dsB]) {
      await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,'WH-MAIN','Main Warehouse','active','main')`, [randomUUID()]);
    }
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, inert, undefined);
    const treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, inert);
    service = new ShipmentService(h.controlPlane, numbering, inert, inert, audit, inert, inventory, inert, treasury, inert, inert, inert);
    const scopes = new AccessScopeService(inert, inert);
    jest.spyOn(scopes, 'forRequest').mockImplementation(async () => scope);
    // Integration with the F-1 vehicle access rule: this caller is a company administrator (a fleet reader), so the branch scope is the only thing that narrows what he sees - exactly what this spec proves
    await dsA.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Branch Admin',$2) ON CONFLICT DO NOTHING`, [userId, `branch-admin-${userId.slice(0, 6)}@test.local`]);
    await dsA.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const adminRole: Array<{ id: string }> = await dsA.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await dsA.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), userId, adminRole[0].id]);
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const access = new VehicleAccessService(authorization, new PermissionService(dsA.getRepository(RolePermission), authorization));
    controller = new ShipmentController(service, access, new OrgContextService(scopes));
  });
  afterAll(async () => h.teardown());

  it('a Company WITHOUT branches keeps working as before: no branch needed, legacy text accepted', async () => {
    scope = unrestricted();
    const v = await controller.createVehicle(req(dsA), { code: 'V-LEGACY', plateNumber: 'A 1', branch: 'Old free text' } as never);
    expect(v.orgUnitId).toBeNull();
    expect(v.branch).toBe('Old free text');
  });

  it('once branches exist: a branch is required — even for an unrestricted administrator (no silent default)', async () => {
    const org = new OrganizationService(dsA);
    ids.root = (await org.createUnit('company', 'Mother')).id;
    ids.cairo = (await org.createUnit('branch', 'Cairo', ids.root)).id;
    ids.tanta = (await org.createUnit('branch', 'Tanta', ids.root)).id;
    ids.dept = (await org.createUnit('department', 'Ops', ids.cairo)).id;
    scope = unrestricted();
    await expect(controller.createVehicle(req(dsA), { code: 'V-NOBRANCH', plateNumber: 'B 1' } as never)).rejects.toThrow(/Select the branch/i);
    expect(await q(dsA, `SELECT 1 FROM vehicles WHERE code = 'V-NOBRANCH'`)).toHaveLength(0); // nothing half-created
  });

  it('a caller who can reach exactly one branch gets it (single-branch rule); a caller with none is refused', async () => {
    scope = restrictedTo(ids.tanta);
    const v = await controller.createVehicle(req(dsA), { code: 'V-TANTA', plateNumber: 'C 1' } as never);
    expect(v.orgUnitId).toBe(ids.tanta);
    scope = restrictedTo();
    await expect(controller.createVehicle(req(dsA), { code: 'V-NONE', plateNumber: 'C 2' } as never)).rejects.toThrow(/No branch is available/i);
  });

  it('the chosen branch is inherited by the custody sub-location and the custody treasury account, and mirrored into the legacy text', async () => {
    scope = unrestricted();
    const v = await controller.createVehicle(req(dsA), { code: 'V-CAIRO', plateNumber: 'D 1', orgUnitId: ids.cairo } as never);
    expect(v.orgUnitId).toBe(ids.cairo);
    expect(v.branch).toBe('Cairo');
    expect((await q(dsA, `SELECT "orgUnitId" FROM warehouses WHERE id = $1`, [v.warehouseId]))[0].orgUnitId).toBe(ids.cairo);
    expect((await q(dsA, `SELECT "orgUnitId" FROM treasury_accounts WHERE id = $1`, [v.custodyAccountId]))[0].orgUnitId).toBe(ids.cairo);
  });

  it('server-side validation: foreign Company id -> 404, department -> 400, archived -> 400, outside the caller scope -> 404, malformed -> 400', async () => {
    const foreign = (await new OrganizationService(dsB).createUnit('branch', 'Beta branch')).id;
    scope = unrestricted();
    await expect(controller.createVehicle(req(dsA), { code: 'V-X1', plateNumber: 'E', orgUnitId: foreign } as never)).rejects.toThrow(/Not Found/i);
    await expect(controller.createVehicle(req(dsA), { code: 'V-X2', plateNumber: 'E', orgUnitId: ids.dept } as never)).rejects.toThrow(/not a branch/i);
    await expect(controller.createVehicle(req(dsA), { code: 'V-X3', plateNumber: 'E', orgUnitId: 'not-a-uuid' } as never)).rejects.toThrow(/not valid/i);
    const org = new OrganizationService(dsA);
    const spare = (await org.createUnit('branch', 'Spare', ids.root)).id;
    await org.archiveUnit(spare);
    await expect(controller.createVehicle(req(dsA), { code: 'V-X4', plateNumber: 'E', orgUnitId: spare } as never)).rejects.toThrow(/archived/i);
    scope = restrictedTo(ids.tanta);
    await expect(controller.createVehicle(req(dsA), { code: 'V-X5', plateNumber: 'E', orgUnitId: ids.cairo } as never)).rejects.toThrow(/Not Found/i);
    expect(await q(dsA, `SELECT 1 FROM vehicles WHERE code LIKE 'V-X%'`)).toHaveLength(0);
  });

  it('moving a vehicle to another branch moves its custody sub-location and account with it (audited)', async () => {
    scope = unrestricted();
    const v = (await q(dsA, `SELECT id, "warehouseId", "custodyAccountId" FROM vehicles WHERE code = 'V-CAIRO'`))[0];
    const moved = await controller.updateVehicle(req(dsA), v.id, { orgUnitId: ids.tanta } as never);
    expect(moved.orgUnitId).toBe(ids.tanta);
    expect(moved.branch).toBe('Tanta');
    expect((await q(dsA, `SELECT "orgUnitId" FROM warehouses WHERE id = $1`, [v.warehouseId]))[0].orgUnitId).toBe(ids.tanta);
    expect((await q(dsA, `SELECT "orgUnitId" FROM treasury_accounts WHERE id = $1`, [v.custodyAccountId]))[0].orgUnitId).toBe(ids.tanta);
    expect(await q(dsA, `SELECT 1 FROM audit_records WHERE action = 'shipment.vehicle.updated' AND "resourceId" = $1`, [v.id])).toHaveLength(1);
  });

  it('legacy mapping report: exact name -> proposed, unknown -> unmatched, no text -> no_text, duplicate names -> ambiguous; nothing is applied', async () => {
    await q(dsA, `INSERT INTO org_units (type, name, "parentId") VALUES ('branch','Twin',$1),('branch','Twin',$1)`, [ids.root]);
    for (const [code, text] of [['L-1', 'cairo'], ['L-2', 'Nowhere'], ['L-3', null], ['L-4', 'Twin']] as const) {
      await q(dsA, `INSERT INTO vehicles (code, "plateNumber", branch, status) VALUES ($1,'P',$2,'active')`, [code, text]);
    }
    const report = await service.vehicleBranchMappingReport(dsA.manager);
    const by = Object.fromEntries(report.rows.map((r) => [r.code, r]));
    expect(by['L-1']).toMatchObject({ status: 'proposed', candidates: [expect.objectContaining({ id: ids.cairo })] });
    expect(by['L-2'].status).toBe('unmatched');
    expect(by['L-3'].status).toBe('no_text');
    expect(by['L-4'].status).toBe('ambiguous');
    expect(by['V-LEGACY'].status).toBe('unmatched'); // the free text created before branches existed
    expect(await q(dsA, `SELECT 1 FROM vehicles WHERE code LIKE 'L-%' AND "orgUnitId" IS NOT NULL`)).toHaveLength(0); // report only
  });

  it('owner-confirmed application of the report: only an unambiguous proposed match is applied (through the audited edit); everything else is skipped with a reason', async () => {
    scope = unrestricted();
    const idOf = async (code: string) => (await q(dsA, `SELECT id FROM vehicles WHERE code = $1`, [code]))[0].id as string;
    const result = await controller.applyVehicleBranchMapping(req(dsA), { vehicleIds: [await idOf('L-1'), await idOf('L-2'), await idOf('L-3'), await idOf('L-4'), randomUUID()] });
    expect(result.applied).toEqual([expect.objectContaining({ code: 'L-1', orgUnitId: ids.cairo })]);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(['ambiguous', 'no_text', 'not_found_or_already_assigned', 'unmatched']);
    const l1 = (await q(dsA, `SELECT "orgUnitId", branch FROM vehicles WHERE code = 'L-1'`))[0];
    expect(l1).toEqual({ orgUnitId: ids.cairo, branch: 'Cairo' });
    expect((await q(dsA, `SELECT 1 FROM vehicles WHERE code IN ('L-2','L-3','L-4') AND "orgUnitId" IS NOT NULL`))).toHaveLength(0);
    const again = await controller.applyVehicleBranchMapping(req(dsA), { vehicleIds: [await idOf('L-1')] }); // idempotent
    expect(again.applied).toEqual([]);
  });

  it('cross-branch isolation: a caller scoped to one branch lists only that branch’s vehicles (plus unlinked legacy ones) and gets 404 on another branch’s vehicle', async () => {
    const cairoVehicle = (await controller.createVehicle(req(dsA), { code: 'V-CAIRO-2', plateNumber: 'F 1', orgUnitId: ids.cairo } as never)).id;
    scope = restrictedTo(ids.tanta);
    const codes = (await controller.listVehicles(req(dsA))).map((v) => v.code);
    expect(codes).toContain('V-TANTA');
    expect(codes).toContain('V-LEGACY'); // unlinked = visible to everyone (D-5)
    expect(codes).not.toContain('V-CAIRO-2');
    await expect(controller.setVehicleStatus(req(dsA), cairoVehicle, { status: 'retired' } as never)).rejects.toThrow(/Not Found/i);
    await expect(controller.getVehicleOverview(req(dsA), cairoVehicle)).rejects.toThrow(/Not Found/i);
    await expect(controller.updateVehicle(req(dsA), cairoVehicle, { plateNumber: 'HACK' } as never)).rejects.toThrow(/Not Found/i);
    // integration audit 2026-10-26: the expense-float routes keep the branch scope too (assigning a float to / listing candidates for another branch's vehicle -> 404, nothing changes)
    await expect(controller.setVehicleExpenseFloat(req(dsA), cairoVehicle, { treasuryAccountId: null } as never)).rejects.toThrow(/Not Found/i);
    await expect(controller.expenseFloatCandidates(req(dsA), cairoVehicle)).rejects.toThrow(/Not Found/i);
    expect((await q(dsA, `SELECT status, "plateNumber" FROM vehicles WHERE id = $1`, [cairoVehicle]))[0]).toEqual({ status: 'active', plateNumber: 'F 1' });
    scope = unrestricted();
    expect((await controller.listVehicles(req(dsA))).map((v) => v.code)).toContain('V-CAIRO-2');
    expect(await controller.expenseFloatCandidates(req(dsA), cairoVehicle)).toEqual(expect.any(Array)); // in scope again: answered (the list itself is proven by the float-candidates spec)
  });

  it('Company B is untouched by all of the above', async () => {
    expect(await q(dsB, `SELECT 1 FROM vehicles`)).toHaveLength(0);
  });
});
