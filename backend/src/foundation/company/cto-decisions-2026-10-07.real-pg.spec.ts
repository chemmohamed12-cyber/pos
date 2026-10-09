import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { seedCompanyAdministratorRole } from './company-role-seeding';
import { COMPANY_ADMIN_ROLE_KEY } from '../module-registry/role-templates';
import { COMPANY_ADMINISTRATION_NODES, COMPANY_ORGANIZATION_MANAGE_NODE } from '../permission/company-nodes';
import { WORKFLOW_NODES, WORKFLOW_RULE_BY_KEY } from '../authorization/workflow-rules';
import { WorkflowAccess } from '../authorization/workflow-access';
import { loadAuthorizationContext } from '../authorization/authorization-context.loader';
import { AccessScopeService } from '../scope/access-scope.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { CompanyAdminOrganizationNode1790012000000 } from '../../database/migrations/core/1790012000000-CompanyAdminOrganizationNode';
import { ReclassifyOrganizationAdministration1790013000000 } from '../../database/migrations/core/1790013000000-ReclassifyOrganizationAdministration';

const OLD_WF_ORGANIZATION_NODE = 'wf.core.organization.manage';

/**
 * CTO decisions of 2026-10-07 — real-Postgres proof:
 *  Decision 3: a NEW Company's initial administrator holds `company_admin` ONLY — the Company administration nodes (users, roles, organization, backups,
 *              audit) and NO workflow (`wf.*`) / operational capability (CTO ruling B1: Organization administration is an administration node); it is not data-unrestricted; it administers the org tree and scopes without
 *              being able to elevate itself.
 *  Decisions 3 / 4-C: no self-elevation, also for Company administrators — nobody adds to or widens THEIR OWN access scope.
 * (Decision 4-C for support access is covered where the support access lives: platform-authorization.f4.real-pg.spec.ts.)
 */
describe('CTO decisions 2026-10-07 (real Postgres)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let dsA: DataSource;
  let dsB: DataSource;
  let scopes: AccessScopeService;
  const ids = { root: randomUUID(), branchX: randomUUID(), branchY: randomUUID() };
  const adminUser = randomUUID();
  const other = randomUUID();

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'cto_dec', roleModuleCodes: ['sales'] });
    dsA = await h.connections.getDataSource(h.companyAId);
    dsB = await h.connections.getDataSource(h.companyBId);
    scopes = new AccessScopeService(dsA, new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole)));
    const o = dsA.options as { host: string; port: number; username: string; password: string; database: string };
    await seedCompanyAdministratorRole({ host: o.host, port: o.port, username: o.username, password: o.password, database: o.database });
    const [{ id: roleId }] = await dsA.query(`SELECT id FROM roles WHERE key = $1`, [COMPANY_ADMIN_ROLE_KEY]);
    await dsA.query(`INSERT INTO user_roles ("userId", "roleId") VALUES ($1, $2)`, [adminUser, roleId]);
    await dsA.query(`INSERT INTO org_units (id, type, name, "parentId") VALUES ($1, 'company', 'Root', NULL), ($2, 'branch', 'X', $1), ($3, 'branch', 'Y', $1)`, [ids.root, ids.branchX, ids.branchY]);
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('cto_dec teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  it('Decision 3 + ruling B1 — the initial administrator (`company_admin`) holds exactly the Company administration nodes (incl. Organization administration) and NO workflow capability at all', async () => {
    const grants: Array<{ n: string; a: string }> = await dsA.query(`SELECT rp."nodeKey" n, rp.access a FROM role_permissions rp JOIN roles r ON r.id = rp."roleId" WHERE r.key = $1 ORDER BY 1`, [COMPANY_ADMIN_ROLE_KEY]);
    expect(grants.map((g) => g.n).sort()).toEqual([...COMPANY_ADMINISTRATION_NODES].sort());
    expect(COMPANY_ADMINISTRATION_NODES).toContain(COMPANY_ORGANIZATION_MANAGE_NODE);
    expect(grants.every((g) => g.a === 'editable')).toBe(true);
    expect(grants.filter((g) => g.n.startsWith('wf.'))).toEqual([]); // ruling B1: not a single wf.* node
    expect(WORKFLOW_NODES.filter((n) => grants.some((g) => g.n === n))).toEqual([]);
    expect(grants.some((g) => !g.n.startsWith('core.company.'))).toBe(false); // no module-wide / operational / critical node either
  });

  it('Decision 3 — what that administrator can and cannot do: administers users / roles / organization; no ERP operation, not data-unrestricted', async () => {
    const ctx = await loadAuthorizationContext(dsA.manager, adminUser, h.companyAId);
    expect(ctx.roleKeys).toEqual([COMPANY_ADMIN_ROLE_KEY]);
    expect(ctx.hasAtLeast('core.company.members.manage', 'editable')).toBe(true);
    expect(ctx.hasAtLeast('core.company.roles.manage', 'editable')).toBe(true);
    expect(ctx.hasAtLeast(COMPANY_ORGANIZATION_MANAGE_NODE, 'editable')).toBe(true); // organization / scope administration (an administration node, ruling B1)
    expect(WORKFLOW_RULE_BY_KEY.has('core.organization.manage')).toBe(false); // the former workflow rule is retired, not duplicated
    const wf = new WorkflowAccess(ctx, 'capability');
    expect(wf.allows('core.scope.unrestricted')).toBe(false); // administration is not a data privilege
    for (const rule of ['sales.order.submit', 'sales.order.manager_approve', 'inventory.warehouse_tx.post', 'logistics.shipment.assign_driver', 'sales.customer.read_any']) expect(wf.allows(rule)).toBe(false);
    expect(ctx.hasAtLeast('sales.order.create', 'read-only')).toBe(false);
    expect(ctx.hasAtLeast('accounting.journal.post', 'read-only')).toBe(false);
  });

  it('Decision 3 — the migration gives an EXISTING `company_admin` the Organization administration node (idempotent, additive); a Company without that role is untouched', async () => {
    await dsA.query(`DELETE FROM role_permissions WHERE "nodeKey" = $1 AND "roleId" IN (SELECT id FROM roles WHERE key = $2)`, [COMPANY_ORGANIZATION_MANAGE_NODE, COMPANY_ADMIN_ROLE_KEY]);
    const before = (await dsA.query(`SELECT count(*)::int n FROM role_permissions`))[0].n;
    const m = new CompanyAdminOrganizationNode1790012000000();
    for (let i = 0; i < 2; i++) {
      const qr = dsA.createQueryRunner();
      try { await m.up(qr); } finally { await qr.release(); }
    }
    expect((await dsA.query(`SELECT count(*)::int n FROM role_permissions`))[0].n).toBe(before + 1); // exactly one grant, however often it runs
    const qrB = dsB.createQueryRunner();
    const beforeB = (await dsB.query(`SELECT count(*)::int n FROM role_permissions`))[0].n;
    try { await m.up(qrB); } finally { await qrB.release(); }
    expect((await dsB.query(`SELECT count(*)::int n FROM role_permissions`))[0].n).toBe(beforeB); // Company B has no company_admin: nothing changes
  });

  it('Ruling B1 — reclassification migration: every holder of the former wf node gets the administration node at the SAME access, the wf rows disappear (company_admin included), idempotent, inverse restores; provisioning already left the legacy admin reclassified', async () => {
    const grantsOf = async (ds: DataSource, roleId: string) => (await ds.query(`SELECT "nodeKey" n, access a FROM role_permissions WHERE "roleId" = $1 AND "nodeKey" IN ($2, $3) ORDER BY 1`, [roleId, OLD_WF_ORGANIZATION_NODE, COMPANY_ORGANIZATION_MANAGE_NODE])) as Array<{ n: string; a: string }>;
    // provisioning ran every migration: the legacy admin (granted the wf node by WorkflowCapabilityGrants) now holds the administration node instead
    const [{ id: legacyAdmin }] = await dsB.query(`SELECT id FROM roles WHERE key = 'admin'`);
    expect(await grantsOf(dsB, legacyAdmin)).toEqual([{ n: COMPANY_ORGANIZATION_MANAGE_NODE, a: 'editable' }]);
    // a Company that ran the pre-B1 migrations: company_admin carries the old wf node, a custom role holds it editable, another read-only
    const [{ id: ca }] = await dsA.query(`SELECT id FROM roles WHERE key = $1`, [COMPANY_ADMIN_ROLE_KEY]);
    const [{ id: editor }] = await dsA.query(`INSERT INTO roles (key, type, "nameEn") VALUES ($1, 'custom', 'Org editor') RETURNING id`, ['custom.b1_editor_' + Date.now()]);
    const [{ id: viewer }] = await dsA.query(`INSERT INTO roles (key, type, "nameEn") VALUES ($1, 'custom', 'Org viewer') RETURNING id`, ['custom.b1_viewer_' + Date.now()]);
    await dsA.query(`DELETE FROM role_permissions WHERE "roleId" = $1 AND "nodeKey" = $2`, [ca, COMPANY_ORGANIZATION_MANAGE_NODE]);
    await dsA.query(`INSERT INTO role_permissions ("roleId", "nodeKey", access) VALUES ($1, $4, 'editable'), ($2, $4, 'editable'), ($3, $4, 'read-only')`, [ca, editor, viewer, OLD_WF_ORGANIZATION_NODE]);
    const m = new ReclassifyOrganizationAdministration1790013000000();
    const run = async (fn: 'up' | 'down') => { const qr = dsA.createQueryRunner(); try { await m[fn](qr); } finally { await qr.release(); } };
    await run('up'); await run('up'); // idempotent
    expect(await grantsOf(dsA, ca)).toEqual([{ n: COMPANY_ORGANIZATION_MANAGE_NODE, a: 'editable' }]);
    expect(await grantsOf(dsA, editor)).toEqual([{ n: COMPANY_ORGANIZATION_MANAGE_NODE, a: 'editable' }]);
    expect(await grantsOf(dsA, viewer)).toEqual([{ n: COMPANY_ORGANIZATION_MANAGE_NODE, a: 'read-only' }]); // same access: nobody gains
    expect((await dsA.query(`SELECT count(*)::int n FROM role_permissions WHERE "nodeKey" = $1`, [OLD_WF_ORGANIZATION_NODE]))[0].n).toBe(0);
    await run('down'); // documented inverse (Blueprint §25)
    expect(await grantsOf(dsA, viewer)).toEqual([{ n: OLD_WF_ORGANIZATION_NODE, a: 'read-only' }]);
    await run('up');
    expect(await grantsOf(dsA, ca)).toEqual([{ n: COMPANY_ORGANIZATION_MANAGE_NODE, a: 'editable' }]);
    await dsA.query(`DELETE FROM role_permissions WHERE "roleId" = ANY($1::uuid[])`, [[editor, viewer]]);
    await dsA.query(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [[editor, viewer]]);
  });

  it('Decisions 3 / 4-C — scope administration without self-elevation: the Organization administrator may place others on ANY unit; nobody adds to or widens their OWN scope; narrowing is always allowed', async () => {
    const empty = await scopes.resolve(adminUser, dsA.manager); // company_admin: no data scope of its own
    expect(empty.unrestricted).toBe(false);
    expect(empty.unitIds.size).toBe(0);
    // without the administrative reach it could grant nothing outside its (empty) scope
    await expect(scopes.replaceGrants(empty, other, [{ orgUnitId: ids.branchX, includeDescendants: true }], adminUser, dsA.manager)).rejects.toMatchObject({ status: 404 });
    // with the Organization administration reach (what `canAdministerAllUnits` reports for company_admin) it can
    const ok = await scopes.replaceGrants(empty, other, [{ orgUnitId: ids.branchX, includeDescendants: true }, { orgUnitId: ids.root, includeDescendants: false }], adminUser, dsA.manager, { organizationAdmin: true });
    expect(ok.after).toHaveLength(2);
    // ...but NEVER for itself: adding or widening its own scope is refused, whatever its reach
    await expect(scopes.replaceGrants(empty, adminUser, [{ orgUnitId: ids.branchY, includeDescendants: true }], adminUser, dsA.manager, { organizationAdmin: true })).rejects.toMatchObject({ code: 'SELF_SCOPE_CHANGE' });
    const unrestricted = { userId: adminUser, unrestricted: true, unitIds: new Set<string>() };
    await expect(scopes.replaceGrants(unrestricted, adminUser, [{ orgUnitId: ids.branchY, includeDescendants: true }], adminUser, dsA.manager)).rejects.toMatchObject({ code: 'SELF_SCOPE_CHANGE' }); // not even an unrestricted administrator
    expect(await scopes.listGrants(adminUser, dsA.manager)).toHaveLength(0); // nothing was written
    // a grant someone else gave it can always be narrowed or removed by it (narrowing is not elevation)
    await dsA.query(`INSERT INTO access_scopes ("userId", "orgUnitId", "includeDescendants") VALUES ($1, $2, true)`, [adminUser, ids.branchX]);
    const narrowed = await scopes.replaceGrants(empty, adminUser, [{ orgUnitId: ids.branchX, includeDescendants: false }], adminUser, dsA.manager);
    expect(narrowed.after).toEqual([{ orgUnitId: ids.branchX, includeDescendants: false }]);
    const removed = await scopes.replaceGrants(empty, adminUser, [], adminUser, dsA.manager);
    expect(removed.after).toEqual([]);
  });
});
