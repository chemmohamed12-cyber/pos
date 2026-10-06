import { DataSource } from 'typeorm';
import { AuthorizationService } from '../authorization/authorization.service';
import { PermissionService } from '../permission/permission.service';
import { MODULE_REGISTRY } from '../module-registry/module-registry';
import { COMPANY_AUDIT_VIEW_NODE, COMPANY_BACKUP_MANAGE_NODE, COMPANY_MEMBERS_MANAGE_NODE, seedCompanyAdminRole, seedCompanyRoleTemplates } from '../company/company-role-seeding';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { buildProvisioningKit } from '../testing/saas-provisioning-kit';
import { Recorder, assertIsolatedInstance, dbConfig, dropDisposableDatabase, hashFile, hashTree, residueOf } from '../testing/saas-characterization.helpers';

/**
 * WP-0.5c — TEST-ONLY characterization (CTO-authorized, 2026-10-05).
 * Question (Phase 0 study F4, code-reading only): a Company created the way the Create
 * Company screen does it — `{ name, initialAdminUserId }` only, so `tags` omitted
 * (every migration tag) and `roleModuleCodes` omitted (`[]`) — what can its initial
 * administrator actually do? Runs the REAL DatabaseProvisioningService end to end on
 * disposable databases on the isolated instance. No production code changed.
 */
describe('WP-0.5c characterization — what the initial admin of a UI-created Company can do (real provisioning, isolated instance)', () => {
  jest.setTimeout(1_800_000);
  const rec = new Recorder();
  const PREFIX = 'wp05c';
  const COMPANY_DB = 'daii_test_wp05c_ui_company';
  const sources = ['src/foundation/database-provisioning/database-provisioning.service.ts', 'src/foundation/company/company-role-seeding.ts', 'src/foundation/permission/permission.service.ts', 'src/foundation/testing/saas-provisioning-kit.ts'];
  let h: TwoCompanyHarness;
  let kit: ReturnType<typeof buildProvisioningKit>;
  let companyId: string;
  let adminUserId: string;
  let before: Record<string, string>;
  let migrationsBefore: string;
  const permission = new PermissionService({} as never, new AuthorizationService({} as never, {} as never));
  const salesNodes = () => (MODULE_REGISTRY.manifest('sales' as never)?.permission_nodes ?? []).map((n) => n.node);

  beforeAll(async () => {
    assertIsolatedInstance();
    before = Object.fromEntries(sources.map((s) => [s, hashFile(s)]));
    migrationsBefore = hashTree('src/database/migrations');
    h = await setUpTwoCompanyHarness({ namePrefix: PREFIX, roleModuleCodes: [] });
    kit = buildProvisioningKit(h);
  });

  afterAll(async () => {
    await h.teardown();
    await dropDisposableDatabase(COMPANY_DB);
    rec.record('sourceHashesBefore', before);
    rec.record('sourceHashesAfter', Object.fromEntries(sources.map((s) => [s, hashFile(s)])));
    rec.record('migrationsTreeBefore', migrationsBefore);
    rec.record('migrationsTreeAfter', hashTree('src/database/migrations'));
    rec.record('residue', await residueOf('daii_test_wp05c'));
    rec.flush('wp05c');
    expect(await residueOf('daii_test_wp05c')).toEqual([]);
  });

  it('PROVISION — the Create Company flow (name + initialAdminUserId, tags and roleModuleCodes omitted) reaches READY/ACTIVE', async () => {
    adminUserId = (await h.users.create({ fullName: 'WP05c UI Admin', email: 'wp05c-ui-admin@test.local' })).id;
    const company = await kit.createCompanyRow('WP05c UI Company');
    companyId = company.id;
    const result = await kit.provisionInto({ companyId, databaseName: COMPANY_DB, initialAdminUserId: adminUserId });
    rec.record('provisioned', { migratedTags: result.migratedNames.length, roleSeedResult: result.roleSeedResult, entitlementApplied: result.entitlementApplied, readyMarked: result.readyMarked });
    expect(result.readyMarked).toBe(true);
    expect((await h.companies.findById(companyId))?.status).toBe('READY');
    expect((await h.controlPlane.getRepository(DatabaseRegistry).findOneOrFail({ where: { companyId } })).status).toBe('ACTIVE');
  });

  it('F4 (runtime, RECORDED) — what the initial admin of a UI-created Company effectively holds: the three core Company nodes are editable; module nodes and platform-style core nodes are RECORDED, not assumed', async () => {
    const ds = await h.connections.getDataSource(companyId);
    for (const node of [COMPANY_MEMBERS_MANAGE_NODE, COMPANY_BACKUP_MANAGE_NODE, COMPANY_AUDIT_VIEW_NODE]) {
      expect(await permission.hasAtLeast(adminUserId, node, 'editable', ds.manager)).toBe(true);
    }
    const nodes = salesNodes();
    expect(nodes.length).toBeGreaterThan(0);
    const granted: string[] = [];
    for (const node of nodes) if (await permission.hasAtLeast(adminUserId, node, 'read-only', ds.manager)) granted.push(node);
    const platformStyle: Record<string, string> = {};
    for (const node of ['core.limit.edit', 'core.entitlement', 'core.config', 'system.release']) platformStyle[node] = await permission.resolve(adminUserId, node, ds.manager);
    const grantRows = await ds.query(`SELECT rp."nodeKey" FROM "role_permissions" rp JOIN "roles" r ON r.id = rp."roleId" WHERE r."key" = 'admin' ORDER BY rp."nodeKey"`);
    rec.record('salesNodesTotal', nodes.length);
    rec.record('salesNodesGrantedToAdmin', granted.length);
    rec.record('platformStyleNodeAccess', platformStyle);
    rec.record('adminRoleNodes', grantRows.map((r: { nodeKey: string }) => r.nodeKey));
    expect(granted.length).toBeLessThanOrEqual(nodes.length);
  });

  it('RE-SEED (RECORDED) — supplying `roleModuleCodes: [\'sales\']` on the same Company changes (or does not change) the admin\'s module access', async () => {
    const cfg = dbConfig(COMPANY_DB);
    await seedCompanyRoleTemplates(cfg, ['sales']);
    const adminGrants = await seedCompanyAdminRole(cfg, ['sales']);
    const ds: DataSource = await h.connections.getDataSource(companyId);
    const nodes = salesNodes();
    let granted = 0;
    for (const node of nodes) if (await permission.hasAtLeast(adminUserId, node, 'read-only', ds.manager)) granted++;
    rec.record('adminGrantsOnReseed', adminGrants);
    rec.record('salesNodesGrantedAfterReseed', granted);
    expect(granted).toBeGreaterThanOrEqual(0);
  });
});
