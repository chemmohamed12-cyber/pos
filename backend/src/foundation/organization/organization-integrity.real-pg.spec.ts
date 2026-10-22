import { DataSource } from 'typeorm';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { OrganizationService } from './organization.service';
import { OrgUnit } from './org-unit.entity';

/**
 * Enterprise Organizational Structure Engine — Stage 1 (real PostgreSQL). Tree integrity, lifecycle (edit / archive / reactivate) and the root reconciliation:
 * a single canonical Company root, no cycles, a parent/child type matrix, no duplicate siblings, nothing deleted while referenced, ids preserved.
 */
describe('Organization engine — tree integrity and lifecycle (real Postgres)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ds: DataSource;
  let dsB: DataSource;
  let svc: OrganizationService;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'org_engine', extraCompanyTags: ['sales', 'inventory', 'hr'] });
    ds = await h.connections.getDataSource(h.companyAId);
    dsB = await h.connections.getDataSource(h.companyBId);
    svc = new OrganizationService(ds);
  });
  afterAll(async () => h.teardown());

  it('builds a tree: one Company root, branches under it, departments under a branch', async () => {
    ids.root = (await svc.createUnit('company', 'Mother Co')).id;
    ids.cairo = (await svc.createUnit('branch', 'Cairo', ids.root)).id;
    ids.tanta = (await svc.createUnit('branch', 'Tanta', ids.root)).id;
    ids.sales = (await svc.createUnit('department', 'Sales', ids.cairo)).id;
    ids.team = (await svc.createUnit('team', 'Field', ids.sales)).id;
    expect((await svc.listUnits()).length).toBe(5);
  });

  it('refuses a second active root, a parentless branch, a bad parent type, the frozen warehouse type and a blank name', async () => {
    await expect(svc.createUnit('company', 'Other')).rejects.toThrow(/already has a root/i);
    await expect(svc.createUnit('branch', 'Loose')).rejects.toThrow(/under the Company/i);
    await expect(svc.createUnit('branch', 'Odd', ids.sales)).rejects.toThrow(/cannot be placed under/i);
    await expect(svc.createUnit('company', 'Child root', ids.root)).rejects.toThrow(/cannot have a parent/i);
    await expect(svc.createUnit('warehouse', 'WH', ids.cairo)).rejects.toThrow(/Warehouses screen/i);
    await expect(svc.createUnit('department', '   ', ids.cairo)).rejects.toThrow(/name is required/i);
  });

  it('refuses duplicate sibling names (case-insensitive) but allows the same name elsewhere', async () => {
    await expect(svc.createUnit('department', 'sales', ids.cairo)).rejects.toThrow(/already exists/i);
    await expect(svc.createUnit('department', 'Sales', ids.tanta)).resolves.toMatchObject({ name: 'Sales' });
  });

  it('edit: rename, move, and refuse a cycle, a bad type, moving the root, a duplicate name and a missing parent', async () => {
    expect((await svc.updateUnit(ids.team, { name: 'Field Team' })).name).toBe('Field Team');
    await expect(svc.updateUnit(ids.sales, { parentId: ids.team })).rejects.toThrow(/under itself or one of its own/i);
    await expect(svc.updateUnit(ids.sales, { parentId: ids.sales })).rejects.toThrow(/under itself/i);
    const ops = (await svc.createUnit('department', 'Ops', ids.tanta)).id;
    await expect(svc.updateUnit(ids.cairo, { parentId: ops })).rejects.toThrow(/cannot be placed under/i);
    await expect(svc.updateUnit(ids.cairo, { parentId: ids.sales })).rejects.toThrow(/under itself or one of its own/i); // a descendant
    await expect(svc.updateUnit(ids.root, { parentId: ids.cairo })).rejects.toThrow(/cannot be moved/i);
    await expect(svc.updateUnit(ids.cairo, { parentId: null })).rejects.toThrow(/under the Company/i);
    await expect(svc.updateUnit(ids.tanta, { name: 'cairo' })).rejects.toThrow(/already exists/i);
  });

  it('archive: blocked by active sub-units, then allowed bottom-up; archived units are read-only until reactivated', async () => {
    const impact = await svc.getImpact(ids.cairo);
    expect(impact.canArchive).toBe(false);
    expect(impact.activeChildren).toBe(1);
    await expect(svc.archiveUnit(ids.cairo)).rejects.toThrow(/active sub-unit/i);
    await svc.archiveUnit(ids.team);
    await svc.archiveUnit(ids.sales);
    expect((await svc.archiveUnit(ids.cairo)).status).toBe('archived');
    await expect(svc.updateUnit(ids.cairo, { name: 'X' })).rejects.toThrow(/archived/i);
    await expect(svc.createUnit('department', 'New', ids.cairo)).rejects.toThrow(/archived/i);
    await expect(svc.activateUnit(ids.sales)).rejects.toThrow(/Reactivate the parent/i);
    expect((await svc.activateUnit(ids.cairo)).status).toBe('active');
    expect((await svc.activateUnit(ids.sales)).status).toBe('active');
    expect((await svc.activateUnit(ids.team)).status).toBe('active');
  });

  it('archive is refused while master records still point at the unit', async () => {
    const cols: Array<{ column_name: string; is_nullable: string; column_default: string | null }> = await ds.query(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'warehouses' AND table_schema = current_schema()`,
    );
    expect(cols.length).toBeGreaterThan(0);
    const required = cols.filter((c) => c.is_nullable === 'NO' && !c.column_default).map((c) => c.column_name);
    const values: Record<string, string> = { code: 'W1', name: 'Main', type: 'main', kind: 'main' };
    const names = required.filter((c) => c !== 'orgUnitId');
    await ds.query(
      `INSERT INTO "warehouses" (${[...names, 'orgUnitId'].map((c) => `"${c}"`).join(',')}) VALUES (${[...names, 'orgUnitId'].map((_, i) => `$${i + 1}`).join(',')})`,
      [...names.map((c) => values[c] ?? 'x'), ids.tanta],
    );
    const impact = await svc.getImpact(ids.tanta);
    expect(impact.blocking).toEqual([expect.objectContaining({ table: 'warehouses', count: 1 })]);
    await expect(svc.archiveUnit(ids.tanta)).rejects.toThrow(/warehouses still attached/i);
    await ds.query(`UPDATE "warehouses" SET "orgUnitId" = NULL`);
  });

  it('the parent FK no longer cascades: a referenced parent cannot be deleted out from under its sub-units', async () => {
    await expect(ds.query(`DELETE FROM "org_units" WHERE id = $1`, [ids.cairo])).rejects.toThrow(/foreign key|violates/i);
  });

  it('Company B is untouched by A, and reconciliation merges duplicate roots without deleting anything or changing ids', async () => {
    expect(await new OrganizationService(dsB).listUnits()).toEqual([]);
    await ds.query(`DROP INDEX IF EXISTS "IDX_org_units_single_root"`); // simulate legacy data created before the rule existed
    const legacy = (await ds.query(`INSERT INTO "org_units" ("type","name") VALUES ('company','mother') RETURNING id`))[0].id as string;
    const rana = (await ds.query(`INSERT INTO "org_units" ("type","name","parentId") VALUES ('branch','rana',$1) RETURNING id`, [legacy]))[0].id as string;
    const before = await ds.getRepository(OrgUnit).count();
    const dry = await svc.reconcileRoots(ids.root, { rename: 'Renamed Co', dryRun: true });
    expect(dry.movedChildren.map((c) => c.name)).toEqual(['rana']);
    expect((await ds.getRepository(OrgUnit).findOneByOrFail({ id: rana })).parentId).toBe(legacy); // dry run wrote nothing
    const done = await svc.reconcileRoots(ids.root, { rename: 'Renamed Co' });
    expect(done.archivedRoots).toEqual([{ id: legacy, name: 'mother' }]);
    expect(await ds.getRepository(OrgUnit).count()).toBe(before); // nothing deleted
    expect((await ds.getRepository(OrgUnit).findOneByOrFail({ id: rana })).parentId).toBe(ids.root); // id preserved, re-parented
    expect((await ds.getRepository(OrgUnit).findOneByOrFail({ id: legacy })).status).toBe('archived');
    expect((await ds.getRepository(OrgUnit).findOneByOrFail({ id: ids.root })).name).toBe('Renamed Co');
    expect((await svc.reconcileRoots(ids.root, {})).movedChildren).toEqual([]); // repeatable
    expect((await ds.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'IDX_org_units_single_root'`)).length).toBe(1);
  });

  it('reconciliation refuses to touch a root that still has members (a scope source)', async () => {
    await ds.query(`DROP INDEX IF EXISTS "IDX_org_units_single_root"`);
    const legacy = (await ds.query(`INSERT INTO "org_units" ("type","name") VALUES ('company','mother 2') RETURNING id`))[0].id as string;
    const user = await h.users.create({ fullName: 'Member', email: 'org-engine-member@test.local' });
    await ds.query(`INSERT INTO "org_memberships" ("userId","orgUnitId") VALUES ($1,$2)`, [user.id, legacy]);
    await expect(svc.reconcileRoots(ids.root)).rejects.toThrow(/still has members/i);
    expect((await ds.getRepository(OrgUnit).findOneByOrFail({ id: legacy })).status).toBe('active'); // untouched
  });
});

