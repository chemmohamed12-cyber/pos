import { AuthorizationContext } from '../authorization/authorization-context';
import { loadAuthorizationContext } from '../authorization/authorization-context.loader';
import { WorkflowAccess } from '../authorization/workflow-access';
import { WORKFLOW_NODES } from '../authorization/workflow-rules';
import { COMPANY_ADMINISTRATION_NODES, COMPANY_ORGANIZATION_MANAGE_NODE } from '../permission/company-nodes';
import { COMPANY_ADMIN_ROLE_KEY } from '../module-registry/role-templates';
import { permissionCatalogNodes } from '../permission/permission-catalog';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { buildProvisioningKit } from '../testing/saas-provisioning-kit';
import { assertIsolatedInstance, dropDisposableDatabase, residueOf } from '../testing/saas-characterization.helpers';

/**
 * CTO Decision 3 (2026-10-07) — VERIFICATION (not a characterization): a Company created the way the Create Company flow does it (`{ name, initialAdminUserId }` only,
 * no `administratorRole`) is born with `company_admin`, and its initial administrator holds `company_admin` ONLY — administration (users, roles, backups, audit) plus the
 * single Organization administration node; no `wf.*` workflow capability, no module / operational / critical node, no data-unrestricted scope; and the legacy `admin`
 * role is NOT assigned. Runs the REAL `DatabaseProvisioningService` end to end on disposable databases of the isolated instance (like the characterization suites).
 */
describe('Decision 3 — the default administrator of a NEW Company is company_admin only (real provisioning, isolated instance)', () => {
  jest.setTimeout(1_800_000);
  const PREFIX = 'dec3';
  const COMPANY_DB = 'daii_test_dec3_new_company';
  let h: TwoCompanyHarness;
  let kit: ReturnType<typeof buildProvisioningKit>;
  let companyId: string;
  let adminUserId: string;
  let ctx: AuthorizationContext;

  beforeAll(async () => {
    assertIsolatedInstance();
    h = await setUpTwoCompanyHarness({ namePrefix: PREFIX, roleModuleCodes: [] });
    kit = buildProvisioningKit(h);
    adminUserId = (await h.users.create({ fullName: 'Dec3 Initial Admin', email: 'dec3-initial-admin@test.local' })).id;
    companyId = (await kit.createCompanyRow('Dec3 New Company')).id;
    await kit.provisionInto({ companyId, databaseName: COMPANY_DB, initialAdminUserId: adminUserId, roleModuleCodes: ['sales', 'inventory'] }); // module templates exist; the administrator must still not hold them
    const ds = await h.connections.getDataSource(companyId);
    ctx = await loadAuthorizationContext(ds.manager, adminUserId, companyId);
  });

  afterAll(async () => {
    await h.teardown();
    await dropDisposableDatabase(COMPANY_DB);
    expect(await residueOf('daii_test_dec3')).toEqual([]);
  });

  it('the Company reaches READY / ACTIVE and the initial membership carries company_admin (never the legacy admin)', async () => {
    expect((await h.companies.findById(companyId))?.status).toBe('READY');
    expect((await h.controlPlane.getRepository(DatabaseRegistry).findOneOrFail({ where: { companyId } })).status).toBe('ACTIVE');
    const membership = (await h.memberships.findByUserAndCompany(adminUserId, companyId))!;
    expect(membership.roleKey).toBe(COMPANY_ADMIN_ROLE_KEY);
    expect(ctx.roleKeys).toEqual([COMPANY_ADMIN_ROLE_KEY]); // the authority itself: exactly one role, and it is not `admin`
  });

  it('the administrator holds exactly the Company administration nodes: users, roles, organization / scopes (ruling B1: an administration node), backups, audit', async () => {
    const ds = await h.connections.getDataSource(companyId);
    const rows: Array<{ n: string; a: string }> = await ds.query(`SELECT rp."nodeKey" n, rp.access a FROM role_permissions rp JOIN roles r ON r.id = rp."roleId" WHERE r.key = $1`, [COMPANY_ADMIN_ROLE_KEY]);
    expect(rows.map((r) => r.n).sort()).toEqual([...COMPANY_ADMINISTRATION_NODES].sort());
    for (const node of COMPANY_ADMINISTRATION_NODES) expect(ctx.hasAtLeast(node, 'editable')).toBe(true);
    expect(ctx.hasAtLeast(COMPANY_ORGANIZATION_MANAGE_NODE, 'editable')).toBe(true);
    expect(rows.filter((r) => r.n.startsWith('wf.'))).toEqual([]); // ruling B1: no workflow capability by default
  });

  it('…and NOTHING else: no wf.* workflow capability at all, no module / operational / critical node, not data-unrestricted — checked against the whole permission catalog', () => {
    const held = Object.entries(ctx.effectiveFor(permissionCatalogNodes())).map(([n]) => n);
    const allowed = new Set<string>(COMPANY_ADMINISTRATION_NODES);
    expect(held.filter((n) => !allowed.has(n) && !n.startsWith('core.company.')).sort()).toEqual([]); // anything beyond the administration family would be listed here
    expect(held.filter((n) => n.startsWith('wf.') || WORKFLOW_NODES.includes(n))).toEqual([]); // ruling B1: zero workflow capabilities
    expect(new WorkflowAccess(ctx, 'capability').allows('core.scope.unrestricted')).toBe(false);
    for (const op of ['sales.order.create', 'inventory.movement.create', 'accounting.journal.post', 'procurement.purchase_order.approve', 'treasury', 'finance']) expect(ctx.hasAtLeast(op, 'read-only')).toBe(false);
  });

  it('the legacy `admin` role row exists in the new Company (every migration seeds it, with its historical grants) but NOBODY holds it: it is inert', async () => {
    const ds = await h.connections.getDataSource(companyId);
    expect((await ds.query(`SELECT count(*)::int n FROM user_roles ur JOIN roles r ON r.id = ur."roleId" WHERE r.key = 'admin'`))[0].n).toBe(0);
    expect((await ds.query(`SELECT count(*)::int n FROM user_roles WHERE "userId" = $1`, [adminUserId]))[0].n).toBe(1); // exactly company_admin
  });
});
