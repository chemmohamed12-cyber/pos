import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { CORE_COMPANY_ENTITIES } from './core-company-entities';
import { Membership } from './membership.entity';
import { Company } from './company.entity';
import { User } from '../identity/user.entity';
import { MembershipOperation } from './membership-operation.entity';
import { CompanyInvitation } from './company-invitation.entity';
import { MembershipService } from './membership.service';
import { MembershipOperationService } from './membership-operation.service';
import { UsersService } from '../identity/users.service';
import { AuditService } from '../audit/audit.service';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { CompanyUserManagementService, CompanyActor } from './company-user-management.service';
import { CompanyRoleManagementService } from './company-role-management.service';
import { seedCompanyAdministratorRole } from './company-role-seeding';
import { CompanyPackageService } from '../plans/company-package.service';
import { MODULE_ROLE_TEMPLATES, RoleTemplate } from '../module-registry/role-templates';
import { COMPANY_ADMINISTRATION_NODES, COMPANY_MEMBERS_MANAGE_NODE, COMPANY_ROLES_MANAGE_NODE } from '../permission/company-nodes';
import { criticalNodesCovered } from '../permission/role-grant-math';
import { nodeRisk } from '../permission/permission-risk';
import { RoleMetadataAndRolesManageNode1790005000000 } from '../../database/migrations/core/1790005000000-RoleMetadataAndRolesManageNode';

/**
 * Authorization Foundation F3 — real-Postgres proof (two disposable Companies + control plane) for Roles, Templates and the Taxonomy:
 *  role metadata + migration backfill · risk-aware anti-elevation · entitlement filter (E4) · dependency completion · protected roles ·
 *  administration-never-disappears · in-use deletion refusal · template lifecycle (offered, never forced, customised untouched, removals never automatic) ·
 *  the `company_admin` system role (administration only) and the package sync that must not extend it · inactive roles · audit chain.
 */
describe('F3 — roles, templates, taxonomy (real Postgres, two Companies)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let cp: DataSource;
  let memberships: MembershipService;
  let users: UsersService;
  let audit: AuditService;
  let contexts: AuthorizationContextService;
  let mgmt: CompanyUserManagementService;
  let roles: CompanyRoleManagementService;
  let dsA: DataSource;
  let dsB: DataSource;
  const modules: Record<string, Set<string>> = {};
  const entitlementFake = { resolve: async (companyId: string) => ({ modules: modules[companyId], features: new Set<string>(), source: 'package' }) };

  let adminA: string;
  let adminB: string;

  const mk = async (name: string) => (await users.create({ fullName: name, email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${randomUUID().slice(0, 6)}@f3.test` })).id;
  const actorOf = async (ds: DataSource, userId: string): Promise<CompanyActor> => ({ userId, authz: await contexts.load(userId, null, ds.manager) });
  const expectCode = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toMatchObject({ code });
  };
  const roleRow = async (ds: DataSource, key: string) => (await ds.query(`SELECT * FROM roles WHERE "key" = $1`, [key]))[0];
  const grantsOf = async (ds: DataSource, key: string) => (await ds.query(`SELECT rp."nodeKey" n, rp.access a FROM role_permissions rp JOIN roles r ON r.id = rp."roleId" WHERE r."key" = $1 ORDER BY 1`, [key])) as Array<{ n: string; a: string }>;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'f3_roles', roleModuleCodes: ['sales', 'inventory', 'accounting'] });
    const o = h.controlPlane.options as { host: string; port: number; username: string; password: string; database: string };
    cp = new DataSource({ type: 'postgres', host: o.host, port: o.port, username: o.username, password: o.password, database: o.database, entities: [...CORE_COMPANY_ENTITIES, Membership, Company, User, MembershipOperation, CompanyInvitation], synchronize: false });
    await cp.initialize();
    memberships = new MembershipService(cp.getRepository(Membership));
    users = new UsersService(cp.getRepository(User));
    audit = new AuditService(cp);
    contexts = new AuthorizationContextService(cp);
    const ops = new MembershipOperationService(cp.getRepository(MembershipOperation));
    mgmt = new CompanyUserManagementService(memberships, ops, users, audit);
    roles = new CompanyRoleManagementService(audit, entitlementFake as never, contexts, memberships);
    modules[h.companyAId] = new Set(['sales', 'inventory', 'accounting', 'procurement']);
    modules[h.companyBId] = new Set(['sales']);
    dsA = await h.connections.getDataSource(h.companyAId);
    dsB = await h.connections.getDataSource(h.companyBId);
    adminA = (await h.createUserWithAdminRoleIn('F3 Admin A', h.companyAId)).id;
    adminB = (await h.createUserWithAdminRoleIn('F3 Admin B', h.companyBId)).id;
  });

  afterAll(async () => {
    if (cp?.isInitialized) await cp.destroy();
    await h.teardown().catch((e) => console.warn('f3 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  it('role metadata: seeded templates are `template`@v1 (not customised), the existing admin is `legacy` and relabelled "Legacy Administrator (Operational)"', async () => {
    const list = await roles.list(dsA, h.companyAId);
    const byKey = new Map(list.map((r) => [r.key, r]));
    expect(byKey.get('sales.manager')).toMatchObject({ type: 'template', templateKey: 'sales.manager', templateVersion: 1, customized: false, isActive: true });
    expect(byKey.get('admin')).toMatchObject({ type: 'legacy', nameEn: 'Legacy Administrator (Operational)', memberCount: 1 });
    expect(byKey.get('admin')!.criticalNodes).toEqual(expect.arrayContaining(['accounting.fiscal_period.reopen', 'accounting.journal.reverse', 'accounting.cash.adjust', 'inventory.stock_count.adjust'])); // the legacy admin still reaches the critical nodes of its modules: no silent loss
    expect(byKey.get('admin')!.criticalNodes.length).toBeGreaterThanOrEqual(10);
    expect(byKey.get('sales.viewer')!.criticalNodes).toEqual([]);
    const adminGrants = (await grantsOf(dsA, 'admin')).map((g) => g.n);
    expect(adminGrants).toEqual(expect.arrayContaining([COMPANY_MEMBERS_MANAGE_NODE, COMPANY_ROLES_MANAGE_NODE]));
  });

  it('migration: a pre-F3 database is classified from the KEY only, admin gets the new roles node, nothing is removed, and a re-run is a no-op', async () => {
    const qr = dsB.createQueryRunner();
    try {
      await qr.query(`ALTER TABLE roles DROP CONSTRAINT IF EXISTS "CHK_roles_type"`);
      for (const c of ['type', 'templateKey', 'templateVersion', 'templateIgnoredVersion', 'isActive', 'customized', 'nameAr', 'nameEn', 'descriptionAr', 'descriptionEn', 'updatedAt', 'createdBy']) await qr.query(`ALTER TABLE roles DROP COLUMN "${c}"`);
      await qr.query(`DELETE FROM role_permissions WHERE "nodeKey" = '${COMPANY_ROLES_MANAGE_NODE}'`);
      await qr.query(`INSERT INTO roles ("key") VALUES ('driver'), ('finance'), ('totally.custom') ON CONFLICT DO NOTHING`);
      const beforeGrants = (await qr.query(`SELECT count(*)::int n FROM role_permissions`))[0].n;
      const mig = new RoleMetadataAndRolesManageNode1790005000000();
      await mig.up(qr);
      await mig.up(qr); // idempotent
      const rows = await qr.query(`SELECT "key", "type", "templateKey", "templateVersion", "nameEn" FROM roles`);
      const t = (k: string) => rows.find((r: { key: string }) => r.key === k);
      expect(t('sales.manager')).toMatchObject({ type: 'template', templateKey: 'sales.manager', templateVersion: 1 });
      expect(t('driver').type).toBe('legacy');
      expect(t('finance').type).toBe('legacy');
      expect(t('totally.custom').type).toBe('custom');
      expect(t('admin')).toMatchObject({ type: 'legacy', nameEn: 'Legacy Administrator (Operational)' });
      const afterGrants = (await qr.query(`SELECT count(*)::int n FROM role_permissions`))[0].n;
      expect(afterGrants).toBe(beforeGrants + 1); // exactly the one new compatibility grant for admin
      expect((await qr.query(`SELECT count(*)::int n FROM role_permissions rp JOIN roles r ON r.id=rp."roleId" WHERE r."key"='admin' AND rp."nodeKey" = '${COMPANY_ROLES_MANAGE_NODE}'`))[0].n).toBe(1);
    } finally {
      await qr.release();
    }
  });

  it('taxonomy: risk classification (19 critical nodes), entitlement-filtered catalog, bilingual titles', async () => {
    expect(nodeRisk('accounting.journal.reverse')).toBe('critical');
    expect(nodeRisk('accounting.journal.post')).toBe('sensitive');
    expect(nodeRisk('sales.order.view')).toBe('low');
    const a = await roles.catalogFor(h.companyAId);
    const b = await roles.catalogFor(h.companyBId);
    expect(a.some((c) => c.node === 'accounting.journal.reverse')).toBe(true);
    expect(b.some((c) => c.node.startsWith('accounting'))).toBe(false); // B has no accounting entitlement
    expect(b.some((c) => c.node === COMPANY_ROLES_MANAGE_NODE)).toBe(true); // core is always available
    const post = a.find((c) => c.node === 'accounting.journal.post')!;
    expect(post.titleEn).toBe('Post journal');
    expect(post.titleAr).toContain('ترحيل');
    expect(a.every((c) => c.titleAr && c.titleEn)).toBe(true);
  });

  it('custom roles: validation, E4 entitlement, dependency auto-completion, key generation, audit', async () => {
    const A = await actorOf(dsA, adminA);
    await expectCode(roles.createCustom(A, h.companyAId, dsA, { nameEn: 'X', grants: [{ node: 'nope.nothing', access: 'editable' }] }), 'UNKNOWN_NODE');
    await expectCode(roles.createCustom(A, h.companyAId, dsA, { nameEn: 'X', grants: [{ node: 'sales.order.view', access: 'sideways' }] }), 'INVALID_INPUT');
    await expectCode(roles.createCustom(A, h.companyAId, dsA, { grants: [] }), 'INVALID_INPUT');
    const B = await actorOf(dsB, adminB);
    await expectCode(roles.createCustom(B, h.companyBId, dsB, { nameEn: 'Acc', grants: [{ node: 'accounting.journal.view', access: 'read-only' }] }), 'NODE_NOT_ENTITLED'); // E4
    const created = await roles.createCustom(A, h.companyAId, dsA, { nameEn: 'Order Clerk', nameAr: 'كاتب الطلبات', grants: [{ node: 'sales.order.create', access: 'editable' }] });
    expect(created).toMatchObject({ type: 'custom', nameEn: 'Order Clerk', isActive: true, memberCount: 0 });
    expect(created.key).toBe('custom.order_clerk');
    const g = await grantsOf(dsA, created.key);
    expect(g).toEqual(expect.arrayContaining([{ n: 'sales.order.create', a: 'editable' }, { n: 'sales.order.view', a: 'read-only' }])); // view auto-added
    const again = await roles.createCustom(A, h.companyAId, dsA, { nameEn: 'Order Clerk', grants: [] });
    expect(again.key).toBe('custom.order_clerk_2'); // unique key
    expect((await dsA.query(`SELECT count(*)::int n FROM audit_records WHERE action = 'role.created'`))[0].n).toBeGreaterThanOrEqual(2);
  });

  it('anti-elevation on definitions: a role can newly reach CRITICAL nodes only through an editor who holds them; administration authority alone cannot', async () => {
    const carol = await mk('Carol Roles');
    await memberships.create({ userId: carol, companyId: h.companyAId, roleKey: 'people_roles' });
    const [pr] = await dsA.query(`INSERT INTO roles ("key","type","nameEn") VALUES ('people_roles','custom','People roles') RETURNING id`);
    for (const n of COMPANY_ADMINISTRATION_NODES) await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable')`, [pr.id, n]);
    await dsA.query(`INSERT INTO user_roles ("userId","roleId") VALUES ($1,$2)`, [carol, pr.id]);
    const C = await actorOf(dsA, carol);
    const ok = await roles.createCustom(C, h.companyAId, dsA, { nameEn: 'Sales Helper', grants: [{ node: 'sales.order.create', access: 'editable' }] }); // non-critical: allowed
    expect(ok.criticalNodes).toEqual([]);
    await expectCode(roles.createCustom(C, h.companyAId, dsA, { nameEn: 'Reverser', grants: [{ node: 'accounting.journal.reverse', access: 'editable' }] }), 'ROLE_EXCEEDS_GRANTOR');
    await expectCode(roles.createCustom(C, h.companyAId, dsA, { nameEn: 'All Accounting', grants: [{ node: 'accounting', access: 'editable' }] }), 'ROLE_EXCEEDS_GRANTOR'); // module-wide reaches the critical nodes
    await expectCode(roles.update(C, h.companyAId, dsA, ok.id, { grants: [{ node: 'accounting', access: 'editable' }] }), 'ROLE_EXCEEDS_GRANTOR');
    const A = await actorOf(dsA, adminA);
    const withCrit = await roles.createCustom(A, h.companyAId, dsA, { nameEn: 'Reverser', grants: [{ node: 'accounting.journal.reverse', access: 'editable' }] }); // the legacy admin holds it explicitly
    expect(withCrit.criticalNodes).toEqual(['accounting.journal.reverse']);
    await expectCode(roles.clone(C, h.companyAId, dsA, withCrit.id, {}), 'ROLE_EXCEEDS_GRANTOR'); // a clone reaches the same critical node
    expect((await roles.clone(A, h.companyAId, dsA, withCrit.id, { nameEn: 'Reverser 2' })).criticalNodes).toEqual(['accounting.journal.reverse']);
    // assignment of a critical-reaching role is gated by the same rule in the user service
    const eve = await mk('Eve Member');
    await memberships.create({ userId: eve, companyId: h.companyAId, roleKey: '-' });
    await expectCode(mgmt.setRoles(C, h.companyAId, dsA, eve, [withCrit.key]), 'ROLE_EXCEEDS_GRANTOR');
    await mgmt.setRoles(C, h.companyAId, dsA, eve, [ok.key]); // non-critical assignment by administration authority
    expect(await roles.list(dsA, h.companyAId)).toEqual(expect.arrayContaining([expect.objectContaining({ key: ok.key, memberCount: 1 })]));
  });

  it('updates: protected roles are immutable; editing a template role marks it customised; dormant grants of a non-entitled module are kept', async () => {
    const A = await actorOf(dsA, adminA);
    const admin = (await roles.list(dsA, h.companyAId)).find((r) => r.key === 'admin')!;
    await expectCode(roles.update(A, h.companyAId, dsA, admin.id, { nameEn: 'Renamed' }), 'ROLE_PROTECTED');
    await expectCode(roles.remove(A, h.companyAId, dsA, admin.id), 'ROLE_PROTECTED');
    const viewer = (await roles.list(dsA, h.companyAId)).find((r) => r.key === 'sales.viewer')!;
    expect(viewer.customized).toBe(false);
    const upd = await roles.update(A, h.companyAId, dsA, viewer.id, { grants: [{ node: 'sales', access: 'read-only' }, { node: 'inventory.stock.view', access: 'read-only' }] });
    expect(upd.role.customized).toBe(true);
    expect((await grantsOf(dsA, 'sales.viewer')).map((g) => g.n)).toEqual(['inventory.stock.view', 'sales']);
    // downgrade: inventory leaves A's package -> the grant stays, shown dormant, and cannot be re-added elsewhere
    modules[h.companyAId].delete('inventory');
    const det = await roles.detail(dsA, h.companyAId, viewer.id);
    expect(det.grants.find((g) => g.node === 'inventory.stock.view')?.dormant).toBe(true);
    const kept = await roles.update(A, h.companyAId, dsA, viewer.id, { nameEn: 'Sales Viewer+', grants: det.grants.map((g) => ({ node: g.node, access: g.access })) });
    expect((await grantsOf(dsA, 'sales.viewer')).map((g) => g.n)).toContain('inventory.stock.view'); // unchanged dormant grant is retained
    expect(kept.role.nameEn).toBe('Sales Viewer+');
    await expectCode(roles.update(A, h.companyAId, dsA, viewer.id, { grants: [...det.grants.map((g) => ({ node: g.node, access: g.access })), { node: 'inventory.transaction.create', access: 'editable' }] }), 'NODE_NOT_ENTITLED');
    modules[h.companyAId].add('inventory'); // re-enable: restored exactly as before
  });

  it('administration never disappears: an edit that would leave no ACTIVE member able to manage users and roles is refused and rolled back', async () => {
    // Company B: make a single custom role the ONLY source of administration (disposable DB state)
    await dsB.query(`DELETE FROM user_roles WHERE "roleId" = (SELECT id FROM roles WHERE "key"='admin')`);
    const p = await mk('Pat Sole Admin');
    await memberships.create({ userId: p, companyId: h.companyBId, roleKey: 'only_admin' });
    const [r] = await dsB.query(`INSERT INTO roles ("key","type","nameEn") VALUES ('only_admin','custom','Only admin') RETURNING id`);
    for (const n of [COMPANY_MEMBERS_MANAGE_NODE, COMPANY_ROLES_MANAGE_NODE]) await dsB.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable')`, [r.id, n]);
    await dsB.query(`INSERT INTO user_roles ("userId","roleId") VALUES ($1,$2)`, [p, r.id]);
    const P = await actorOf(dsB, p);
    const before = await grantsOf(dsB, 'only_admin');
    await expectCode(roles.update(P, h.companyBId, dsB, r.id, { grants: [{ node: COMPANY_MEMBERS_MANAGE_NODE, access: 'editable' }] }), 'ADMINISTRATION_WOULD_BE_LOST');
    expect(await grantsOf(dsB, 'only_admin')).toEqual(before); // rolled back
    await expectCode(roles.update(P, h.companyBId, dsB, r.id, { grants: [{ node: COMPANY_MEMBERS_MANAGE_NODE, access: 'read-only' }, { node: COMPANY_ROLES_MANAGE_NODE, access: 'editable' }] }), 'ADMINISTRATION_WOULD_BE_LOST');
    // a suspended sole holder does not count either
    const q = await mk('Quinn Backup');
    await memberships.create({ userId: q, companyId: h.companyBId, roleKey: 'only_admin' });
    await dsB.query(`INSERT INTO user_roles ("userId","roleId") VALUES ($1,$2)`, [q, r.id]);
    await memberships.setStatus(q, h.companyBId, 'suspended');
    await expectCode(roles.update(P, h.companyBId, dsB, r.id, { grants: [{ node: COMPANY_ROLES_MANAGE_NODE, access: 'editable' }] }), 'ADMINISTRATION_WOULD_BE_LOST');
    await memberships.setStatus(q, h.companyBId, 'active');
    await roles.update(P, h.companyBId, dsB, r.id, { grants: [{ node: COMPANY_MEMBERS_MANAGE_NODE, access: 'editable' }, { node: COMPANY_ROLES_MANAGE_NODE, access: 'editable' }, { node: COMPANY_ADMINISTRATION_NODES[2], access: 'editable' }] }); // fine: still manageable
    // restore B's admin for later tests
    await dsB.query(`INSERT INTO user_roles ("userId","roleId") SELECT $1, id FROM roles WHERE "key"='admin' ON CONFLICT DO NOTHING`, [adminB]);
  });

  it('deletion: in-use roles are refused, unused custom roles are removed with their grants; templates can be created from the catalog (never assigned) and a duplicate is refused', async () => {
    const A = await actorOf(dsA, adminA);
    const list = await roles.list(dsA, h.companyAId);
    const used = list.find((r) => r.memberCount > 0 && r.type === 'custom')!;
    await expectCode(roles.remove(A, h.companyAId, dsA, used.id), 'ROLE_IN_USE');
    const tmp = await roles.createCustom(A, h.companyAId, dsA, { nameEn: 'Temp Role', grants: [{ node: 'sales.order.view', access: 'read-only' }] });
    await roles.remove(A, h.companyAId, dsA, tmp.id);
    expect(await roleRow(dsA, tmp.key)).toBeUndefined();
    expect((await dsA.query(`SELECT count(*)::int n FROM role_permissions WHERE "roleId" = $1`, [tmp.id]))[0].n).toBe(0);
    await expectCode(roles.remove(A, h.companyAId, dsA, randomUUID()), 'ROLE_NOT_FOUND');
    // missing-module templates exist in the catalog (AZ-04) and are offered, not auto-created
    const tpls = await roles.templates(dsA, h.companyAId);
    for (const k of ['procurement.manager', 'procurement.buyer', 'payroll.manager', 'attendance.viewer', 'commission.manager', 'targets.viewer', 'finance.treasury_officer']) expect(tpls.some((t) => t.key === k)).toBe(true);
    expect(tpls.find((t) => t.key === 'payroll.manager')!.entitled).toBe(false); // not in A's package
    expect(tpls.find((t) => t.key === 'procurement.buyer')!.instantiated).toBe(false);
    await expectCode(roles.createFromTemplate(A, h.companyAId, dsA, 'payroll.manager'), 'NODE_NOT_ENTITLED');
    const buyer = await roles.createFromTemplate(A, h.companyAId, dsA, 'procurement.buyer');
    expect(buyer).toMatchObject({ type: 'template', templateVersion: 1, customized: false, memberCount: 0 });
    await expectCode(roles.createFromTemplate(A, h.companyAId, dsA, 'procurement.buyer'), 'ROLE_EXISTS');
    await expectCode(roles.createFromTemplate(A, h.companyAId, dsA, 'no.such.template'), 'ROLE_NOT_FOUND');
  });

  describe('template lifecycle (offered, never forced)', () => {
    let v2: Record<string, RoleTemplate[]>;
    let A: CompanyActor;
    const makeV2 = () => {
      const copy: Record<string, RoleTemplate[]> = JSON.parse(JSON.stringify(MODULE_ROLE_TEMPLATES));
      const rep = copy.sales.find((t) => t.key === 'sales.rep')!;
      rep.version = 2;
      rep.grants = rep.grants.filter((g) => g.node !== 'sales.deposit' && g.node !== 'sales.catalog').concat([{ node: 'sales.order.approve', access: 'editable' }, { node: 'sales.catalog', access: 'editable' }]); // + approve, catalog raised, deposit dropped
      return copy;
    };

    it('a new template version is OFFERED with a business diff; ignoring is remembered; applying never removes a grant; customised roles are untouched', async () => {
      A = await actorOf(dsA, adminA);
      v2 = makeV2();
      const rep = (await roles.list(dsA, h.companyAId)).find((r) => r.key === 'sales.rep')!;
      expect(rep.templateUpdateAvailable).toBe(false); // catalog still v1
      roles.catalog = v2;
      try {
        const listed = (await roles.list(dsA, h.companyAId)).find((r) => r.key === 'sales.rep')!;
        expect(listed.templateUpdateAvailable).toBe(true);
        const diff = (await roles.templateUpdate(dsA, rep.id))!;
        expect(diff).toMatchObject({ fromVersion: 1, toVersion: 2, customized: false });
        expect(diff.added.map((g) => g.node)).toEqual(['sales.order.approve']);
        expect(diff.changed).toEqual([{ node: 'sales.catalog', from: 'read-only', to: 'editable' }]);
        expect(diff.removedFromTemplate.map((g) => g.node)).toEqual(['sales.deposit']); // informational only
        // ignore -> remembered, no longer offered
        const ign = await roles.ignoreTemplateUpdate(A, h.companyAId, dsA, rep.id);
        expect(ign.templateUpdateAvailable).toBe(false);
        expect(await roles.templateUpdate(dsA, rep.id)).toBeNull();
        // a later version re-offers it
        roles.catalog = JSON.parse(JSON.stringify(v2));
        roles.catalog.sales.find((t) => t.key === 'sales.rep')!.version = 3;
        expect((await roles.templateUpdate(dsA, rep.id))?.toVersion).toBe(3);
        roles.catalog = v2;
        await dsA.query(`UPDATE roles SET "templateIgnoredVersion" = NULL WHERE id = $1`, [rep.id]);
        // apply SELECTED: only the chosen node changes, version not bumped (the rest is still offered)
        const partial = await roles.applyTemplateUpdate(A, h.companyAId, dsA, rep.id, ['sales.order.approve']);
        expect(partial.templateVersion).toBe(1);
        expect((await grantsOf(dsA, 'sales.rep')).find((g) => g.n === 'sales.order.approve')?.a).toBe('editable');
        expect((await grantsOf(dsA, 'sales.rep')).find((g) => g.n === 'sales.catalog')?.a).toBe('read-only');
        // apply ALL: remaining change applied; the dropped template grant is NOT removed
        const full = await roles.applyTemplateUpdate(A, h.companyAId, dsA, rep.id, 'all');
        expect(full.templateVersion).toBe(2);
        const after = await grantsOf(dsA, 'sales.rep');
        expect(after.find((g) => g.n === 'sales.catalog')?.a).toBe('editable');
        expect(after.some((g) => g.n === 'sales.deposit')).toBe(true); // removal never automatic
        expect(await roles.templateUpdate(dsA, rep.id)).toBeNull();
        await expectCode(roles.applyTemplateUpdate(A, h.companyAId, dsA, rep.id, 'all'), 'NO_TEMPLATE_UPDATE');
        // a CUSTOMISED role is never touched
        const inv = (await roles.list(dsA, h.companyAId)).find((r) => r.key === 'inventory.operator')!;
        await roles.update(A, h.companyAId, dsA, inv.id, { grants: [{ node: 'inventory', access: 'read-only' }] });
        roles.catalog = JSON.parse(JSON.stringify(v2));
        roles.catalog.inventory.find((t) => t.key === 'inventory.operator')!.version = 2;
        const cd = (await roles.templateUpdate(dsA, inv.id))!;
        expect(cd.customized).toBe(true);
        await expectCode(roles.applyTemplateUpdate(A, h.companyAId, dsA, inv.id, 'all'), 'ROLE_CUSTOMIZED');
        expect((await grantsOf(dsA, 'inventory.operator')).map((g) => g.n)).toEqual(['inventory']);
      } finally {
        roles.catalog = MODULE_ROLE_TEMPLATES;
      }
    });

    it('an upgrade that would introduce a CRITICAL grant needs an actor who holds it; templates never create critical grants on their own', async () => {
      const carol = (await memberships.findByCompany(h.companyAId)).find((m) => m.roleKey === 'people_roles')!.userId;
      const C = await actorOf(dsA, carol);
      const hrm = (await roles.list(dsA, h.companyAId)).find((r) => r.key === 'accounting.viewer')!; // seeded from the template (customized = false)
      const copy: Record<string, RoleTemplate[]> = JSON.parse(JSON.stringify(MODULE_ROLE_TEMPLATES));
      const t = copy.accounting.find((x) => x.key === 'accounting.viewer')!;
      t.version = 2;
      t.grants = [{ node: 'accounting', access: 'read-only' }, { node: 'accounting.journal.reverse', access: 'editable' }];
      roles.catalog = copy;
      try {
        const diff = (await roles.templateUpdate(dsA, hrm.id))!;
        expect(diff.introducesCritical).toEqual(['accounting.journal.reverse']);
        await expectCode(roles.applyTemplateUpdate(C, h.companyAId, dsA, hrm.id, 'all'), 'ROLE_EXCEEDS_GRANTOR');
        expect((await grantsOf(dsA, 'accounting.viewer')).map((g) => g.n)).toEqual(['accounting']); // unchanged
        await roles.applyTemplateUpdate(await actorOf(dsA, adminA), h.companyAId, dsA, hrm.id, 'all'); // explicit holder
        expect((await grantsOf(dsA, 'accounting.viewer')).map((g) => g.n)).toContain('accounting.journal.reverse');
      } finally {
        roles.catalog = MODULE_ROLE_TEMPLATES;
      }
    });
  });

  it('company_admin (D17): administration authority only — manages users and roles, holds NO operational/critical capability, can assign non-critical roles but not critical ones; a package sync never extends it', async () => {
    const database = { host: (cp.options as { host: string }).host, port: (cp.options as { port: number }).port, username: (cp.options as { username: string }).username, password: (cp.options as { password: string }).password, database: h.companyBDbName };
    const first = await seedCompanyAdministratorRole(database);
    const second = await seedCompanyAdministratorRole(database);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false); // idempotent
    expect((await grantsOf(dsB, 'company_admin')).map((g) => g.n).sort()).toEqual([...COMPANY_ADMINISTRATION_NODES].sort());
    expect(await roleRow(dsB, 'company_admin')).toMatchObject({ type: 'system', nameEn: 'Company Administrator' });
    const ca = await mk('Casey Company Admin');
    await memberships.create({ userId: ca, companyId: h.companyBId, roleKey: 'company_admin' });
    await dsB.query(`INSERT INTO user_roles ("userId","roleId") SELECT $1, id FROM roles WHERE "key"='company_admin'`, [ca]);
    const ctx = await contexts.load(ca, h.companyBId, dsB.manager);
    for (const n of COMPANY_ADMINISTRATION_NODES) expect(ctx.hasAtLeast(n, 'editable')).toBe(true);
    for (const n of ['sales.order.create', 'sales', 'accounting.journal.post', 'accounting.journal.reverse']) expect(ctx.hasAtLeast(n, 'read-only')).toBe(false);
    expect(criticalNodesCovered((await grantsOf(dsB, 'company_admin')).map((g) => ({ node: g.n, access: g.a as 'editable' })))).toEqual([]);
    // it can run the Company (users, roles) — and assign NON-critical roles — but not hand out critical power
    const CA = await actorOf(dsB, ca);
    const newbie = await mk('Nora Newbie');
    await memberships.create({ userId: newbie, companyId: h.companyBId, roleKey: '-' });
    await mgmt.setRoles(CA, h.companyBId, dsB, newbie, ['sales.manager']);
    await expectCode(mgmt.setRoles(CA, h.companyBId, dsB, newbie, ['sales.manager', 'admin']), 'ROLE_EXCEEDS_GRANTOR');
    const sales = await roles.createCustom(CA, h.companyBId, dsB, { nameEn: 'Sales Lead', grants: [{ node: 'sales.order', access: 'editable' }] });
    expect(sales.criticalNodes).toEqual([]);
    // package upgrade: the legacy admin of Company A is extended exactly as before (compat); company_admin of B is not
    const connections = { getDataSource: async (id: string) => (id === h.companyAId ? dsA : dsB) };
    const pkg = new CompanyPackageService(null as never, null as never, null as never, null as never, cp, connections as never, null as never, null as never, audit);
    const beforeB = (await grantsOf(dsB, 'company_admin')).length;
    await pkg.syncCompanyRoles(h.companyBId, ['sales', 'inventory']);
    expect((await grantsOf(dsB, 'company_admin')).length).toBe(beforeB); // administration nodes only, nothing added
    await pkg.syncCompanyRoles(h.companyAId, ['sales', 'inventory']);
    expect((await grantsOf(dsA, 'admin')).map((g) => g.n)).toEqual(expect.arrayContaining(['sales', 'inventory'])); // legacy behaviour unchanged
  });

  it('inactive roles cannot be newly assigned (existing holders keep them); deactivation is audited', async () => {
    const A = await actorOf(dsA, adminA);
    const r = await roles.createCustom(A, h.companyAId, dsA, { nameEn: 'Seasonal', grants: [{ node: 'sales.order.view', access: 'read-only' }] });
    const m1 = await mk('Ivy Holder');
    const m2 = await mk('Jon Later');
    for (const u of [m1, m2]) await memberships.create({ userId: u, companyId: h.companyAId, roleKey: '-' });
    await mgmt.setRoles(A, h.companyAId, dsA, m1, [r.key]);
    const off = await roles.update(A, h.companyAId, dsA, r.id, { isActive: false });
    expect(off.role.isActive).toBe(false);
    await expectCode(mgmt.setRoles(A, h.companyAId, dsA, m2, [r.key]), 'ROLE_INACTIVE');
    expect((await mgmt.assignableRoles(dsA, A)).find((x) => x.key === r.key)?.assignable).toBe(false);
    expect((await dsA.query(`SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id=ur."roleId" WHERE ur."userId"=$1 AND ro."key"=$2`, [m1, r.key])).length).toBe(1);
    await roles.update(A, h.companyAId, dsA, r.id, { isActive: true });
    await mgmt.setRoles(A, h.companyAId, dsA, m2, [r.key]);
  });

  it('A/B isolation: Company B never sees or edits Company A roles; the audit chains verify and carry the F3 events', async () => {
    const aRoles = (await roles.list(dsA, h.companyAId)).map((r) => r.key);
    const bRoles = (await roles.list(dsB, h.companyBId)).map((r) => r.key);
    expect(aRoles).toContain('custom.order_clerk');
    expect(bRoles).not.toContain('custom.order_clerk');
    const aRole = (await roles.list(dsA, h.companyAId)).find((r) => r.key === 'custom.order_clerk')!;
    await expectCode(roles.detail(dsB, h.companyBId, aRole.id), 'ROLE_NOT_FOUND'); // an id from another Company simply does not exist here
    const B = await actorOf(dsB, adminB);
    await expectCode(roles.update(B, h.companyBId, dsB, aRole.id, { nameEn: 'hijack' }), 'ROLE_NOT_FOUND');
    const actions = new Set((await dsA.query(`SELECT DISTINCT action FROM audit_records`)).map((r: { action: string }) => r.action));
    for (const a of ['role.created', 'role.updated', 'role.deleted', 'role.cloned', 'role.template_upgraded', 'role.template_ignored']) expect(actions).toContain(a);
    expect((await audit.verifyCompanyChain(dsA.manager)).valid).toBe(true);
    expect((await audit.verifyCompanyChain(dsB.manager)).valid).toBe(true);
  });
});
