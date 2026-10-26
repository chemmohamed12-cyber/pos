import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { InventoryController } from './inventory.controller';
import { InventoryService } from '../application/inventory.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { OrganizationService } from '../../../foundation/organization/organization.service';
import { AccessScope, AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { OrgContextService } from '../../../foundation/scope/org-context.service';
import { CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Org engine Stage 4 (real PostgreSQL) — warehouses reference their OWNING BRANCH: required (and validated on the server) for a new warehouse once the Company has
 * active branches; a branchless Company behaves exactly as before; the audit reports unassigned / conflicting references and changes nothing.
 */
describe('Warehouses — owning branch (real Postgres)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ds: DataSource;
  let controller: InventoryController;
  let inventory: InventoryService;
  let scope: AccessScope;
  const ids: Record<string, string> = {};
  const userId = randomUUID();
  const req = () => ({ user: { id: userId, email: 'x@test.local', companyId: 'c' }, companyContext: { companyId: 'c', dataSource: ds } }) as unknown as CompanyScopedRequest;
  const unrestricted = (): AccessScope => ({ userId, unrestricted: true, unitIds: new Set<string>() });
  const restrictedTo = (...u: string[]): AccessScope => ({ userId, unrestricted: false, unitIds: new Set(u) });
  const wh = async (code: string) => (await ds.query(`SELECT "orgUnitId", kind FROM warehouses WHERE code = $1`, [code]))[0];

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'warehouse_branch', extraCompanyTags: ['sales', 'inventory'] });
    ds = await h.connections.getDataSource(h.companyAId);
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    inventory = new InventoryService(h.controlPlane, audit, inert, inert, new NumberingService(h.controlPlane), inert, undefined);
    const scopes = new AccessScopeService(inert, inert);
    jest.spyOn(scopes, 'forRequest').mockImplementation(async () => scope);
    controller = new InventoryController(inventory, inert, inert, scopes, undefined, new OrgContextService(scopes));
  });
  afterAll(async () => h.teardown());

  it('a Company without branches: a warehouse is created exactly as before (unassigned, or linked to any existing unit)', async () => {
    scope = unrestricted();
    const org = new OrganizationService(ds);
    ids.dept = (await org.createUnit('department', 'Legacy dept')).id;
    await controller.createWarehouse(req(), { code: 'W-OLD', name: 'Old' } as never);
    await controller.createWarehouse(req(), { code: 'W-OLD2', name: 'Old 2', orgUnitId: ids.dept } as never);
    expect((await wh('W-OLD')).orgUnitId).toBeNull();
    expect((await wh('W-OLD2')).orgUnitId).toBe(ids.dept);
  });

  it('once branches exist: a branch is required (also for the administrator), must be a real active branch of this Company, and is stored', async () => {
    const org = new OrganizationService(ds);
    ids.root = (await org.createUnit('company', 'Mother')).id;
    ids.x = (await org.createUnit('branch', 'X', ids.root)).id;
    ids.y = (await org.createUnit('branch', 'Y', ids.root)).id;
    await expect(controller.createWarehouse(req(), { code: 'W-NEW', name: 'New' } as never)).rejects.toThrow(/Select the branch/i);
    await expect(controller.createWarehouse(req(), { code: 'W-NEW', name: 'New', orgUnitId: ids.dept } as never)).rejects.toThrow(/not a branch/i);
    await expect(controller.createWarehouse(req(), { code: 'W-NEW', name: 'New', orgUnitId: randomUUID() } as never)).rejects.toThrow(/Not Found/i);
    expect(await ds.query(`SELECT 1 FROM warehouses WHERE code = 'W-NEW'`)).toHaveLength(0);
    await controller.createWarehouse(req(), { code: 'W-X', name: 'X wh', orgUnitId: ids.x } as never);
    expect((await wh('W-X')).orgUnitId).toBe(ids.x);
  });

  it('a caller who reaches exactly one branch gets it; a branch outside the caller’s scope is a 404', async () => {
    scope = restrictedTo(ids.y);
    await controller.createWarehouse(req(), { code: 'W-Y', name: 'Y wh' } as never);
    expect((await wh('W-Y')).orgUnitId).toBe(ids.y);
    await expect(controller.createWarehouse(req(), { code: 'W-Z', name: 'Z', orgUnitId: ids.x } as never)).rejects.toThrow(/Not Found/i);
    scope = unrestricted();
  });

  it('re-linking an existing warehouse goes through the same validation', async () => {
    const id = (await ds.query(`SELECT id FROM warehouses WHERE code = 'W-OLD'`))[0].id;
    await expect(controller.setWarehouseOrgUnit(req(), id, { orgUnitId: ids.dept })).rejects.toThrow(/not a branch/i); // branches exist now
    const linked = await controller.setWarehouseOrgUnit(req(), id, { orgUnitId: ids.x });
    expect(linked.orgUnitId).toBe(ids.x);
  });

  it('Excel import: every imported warehouse takes the one validated branch', async () => {
    const res = await inventory.importWarehouseRows([{ code: 'W-I1', name: 'I1' }, { code: 'W-I2', name: 'I2' }], ds.manager, ids.x);
    expect(res.succeeded).toHaveLength(2);
    expect((await wh('W-I1')).orgUnitId).toBe(ids.x);
    expect((await wh('W-I2')).orgUnitId).toBe(ids.x);
  });

  it('org audit: classifies unassigned / not_branch / archived / dangling / custody mismatch, and changes nothing', async () => {
    const org = new OrganizationService(ds);
    const old = (await org.createUnit('branch', 'Old branch', ids.root)).id;
    await org.archiveUnit(old);
    const dangling = randomUUID();
    const mk = (code: string, unit: string | null, kind = 'main', parent: string | null = null) =>
      ds.query(`INSERT INTO warehouses (id, code, name, "orgUnitId", kind, "parentWarehouseId", status) VALUES ($1,$2,$2,$3,$4,$5,'active')`, [randomUUID(), code, unit, kind, parent]);
    await mk('A-UNASSIGNED', null);
    await mk('A-DEPT', ids.dept);
    await mk('A-ARCHIVED', old);
    await mk('A-DANGLING', dangling);
    const parent = (await ds.query(`SELECT id FROM warehouses WHERE code = 'W-X'`))[0].id;
    await mk('A-CUSTODY-OK', ids.x, 'operational', parent);
    await mk('A-CUSTODY-BAD', ids.y, 'operational', parent);
    const before = JSON.stringify(await ds.query(`SELECT * FROM warehouses ORDER BY code`));
    const report = await controller.warehouseOrgAudit(req());
    const by = Object.fromEntries(report.rows.map((r) => [r.code, r.classification]));
    expect(by).toMatchObject({ 'W-X': 'ok', 'A-UNASSIGNED': 'unassigned', 'A-DEPT': 'not_branch', 'A-ARCHIVED': 'archived_unit', 'A-DANGLING': 'missing_unit', 'A-CUSTODY-OK': 'ok', 'A-CUSTODY-BAD': 'custody_mismatch' });
    expect(report.branchesActive).toBe(2);
    expect(report.totals.unassigned).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(await ds.query(`SELECT * FROM warehouses ORDER BY code`))).toBe(before); // read-only
  });

  it('a unit that still has warehouses cannot be archived (impact lists them)', async () => {
    const impact = await new OrganizationService(ds).getImpact(ids.x);
    expect(impact.canArchive).toBe(false);
    expect(impact.blocking).toEqual([expect.objectContaining({ table: 'warehouses' })]);
  });
});
