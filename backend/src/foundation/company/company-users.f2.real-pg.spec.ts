import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ForbiddenException } from '@nestjs/common';
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
import { CompanyInvitationService, hashInvitationToken } from './company-invitation.service';
import { CompanyContextGuard } from './company-context.guard';
import { CompanyUserError } from './company-user-roles';
import { COMPANY_MEMBERS_MANAGE_NODE } from './company-role-seeding';
import { MembershipReconciliationScheduler } from './membership-reconciliation.scheduler';

/**
 * Authorization Foundation F2 — real-Postgres proof (two disposable Companies + a control plane) for Company Users:
 *  directory isolation (A/B) · multi-role per Company · last-administrator protection (incl. concurrency) · anti-self-elevation ·
 *  suspension/removal at the guard · invitations (uniform response, hashed single-use token, expiry, revoke, supersede, inviter re-validation) ·
 *  mirror reconciliation from the authority · audit chain integrity.
 */
describe('F2 — Company Users, invitations, multi-role (real Postgres, two Companies)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let cp: DataSource;
  let memberships: MembershipService;
  let users: UsersService;
  let audit: AuditService;
  let contexts: AuthorizationContextService;
  let mgmt: CompanyUserManagementService;
  let invites: CompanyInvitationService;
  let ops: MembershipOperationService;
  let dsA: DataSource;
  let dsB: DataSource;
  const authFake = { createInvitedIdentity: jest.fn() };

  let adminA1: string;
  let adminA2: string;
  let adminB1: string;
  let alice: string; // member of both Companies with different roles

  const mk = async (name: string) => (await users.create({ fullName: name, email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${randomUUID().slice(0, 6)}@f2.test` })).id;
  const actorOf = async (ds: DataSource, userId: string): Promise<CompanyActor> => ({ userId, authz: await contexts.load(userId, null, ds.manager) });
  const rolesOf = async (ds: DataSource, userId: string) => (await ds.query(`SELECT r."key" k FROM user_roles ur JOIN roles r ON r.id=ur."roleId" WHERE ur."userId"=$1 ORDER BY r."key"`, [userId])).map((r: { k: string }) => r.k);
  const expectCode = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toMatchObject({ code });
  };

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'f2_users' });
    const o = h.controlPlane.options as { host: string; port: number; username: string; password: string; database: string };
    cp = new DataSource({ type: 'postgres', host: o.host, port: o.port, username: o.username, password: o.password, database: o.database, entities: [...CORE_COMPANY_ENTITIES, Membership, Company, User, MembershipOperation, CompanyInvitation], synchronize: false });
    await cp.initialize();
    memberships = new MembershipService(cp.getRepository(Membership));
    users = new UsersService(cp.getRepository(User));
    audit = new AuditService(cp);
    contexts = new AuthorizationContextService(cp);
    ops = new MembershipOperationService(cp.getRepository(MembershipOperation));
    mgmt = new CompanyUserManagementService(memberships, ops, users, audit);
    authFake.createInvitedIdentity.mockImplementation(async (email: string, fullName: string) => {
      const u = await users.create({ email, fullName });
      await users.setStatus(u.id, 'active');
      return users.findById(u.id);
    });
    invites = new CompanyInvitationService(cp.getRepository(CompanyInvitation), cp, memberships, ops, users, authFake as never, h.companies, h.connections, contexts, audit);

    dsA = await h.connections.getDataSource(h.companyAId);
    dsB = await h.connections.getDataSource(h.companyBId);
    adminA1 = (await h.createUserWithAdminRoleIn('Admin A One', h.companyAId)).id;
    adminA2 = (await h.createUserWithAdminRoleIn('Admin A Two', h.companyAId)).id;
    adminB1 = (await h.createUserWithAdminRoleIn('Admin B One', h.companyBId)).id;
    alice = await mk('Alice Dual');
    await memberships.create({ userId: alice, companyId: h.companyAId, roleKey: 'sales.manager' });
    await memberships.create({ userId: alice, companyId: h.companyBId, roleKey: 'sales.viewer' });
    const A = await actorOf(dsA, adminA1);
    const B = await actorOf(dsB, adminB1);
    await mgmt.setRoles(A, h.companyAId, dsA, alice, ['sales.manager']);
    await mgmt.setRoles(B, h.companyBId, dsB, alice, ['sales.viewer']);
  });

  afterAll(async () => {
    if (cp?.isInitialized) await cp.destroy();
    await h.teardown().catch((e) => console.warn('f2 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  it('directory A/B isolation: each Company lists ONLY its own members; the same identity shows each Company its own roles', async () => {
    const dirA = await mgmt.directory(h.companyAId, dsA);
    const dirB = await mgmt.directory(h.companyBId, dsB);
    const idsA = dirA.map((r) => r.userId);
    const idsB = dirB.map((r) => r.userId);
    expect(idsA.sort()).toEqual([adminA1, adminA2, alice].sort());
    expect(idsB.sort()).toEqual([adminB1, alice].sort());
    expect(idsA).not.toContain(adminB1);
    expect(idsB).not.toContain(adminA1);
    expect(dirA.find((r) => r.userId === alice)?.roles.map((r) => r.key)).toEqual(['sales.manager']);
    expect(dirB.find((r) => r.userId === alice)?.roles.map((r) => r.key)).toEqual(['sales.viewer']);
  });

  it('multi-role: a member holds 0..n roles; the union applies; a change in A never touches B; the platform mirror follows the authority', async () => {
    const A = await actorOf(dsA, adminA1);
    const res = await mgmt.setRoles(A, h.companyAId, dsA, alice, ['sales.manager', 'sales.viewer']);
    expect(res.changed).toBe(true);
    expect(await rolesOf(dsA, alice)).toEqual(['sales.manager', 'sales.viewer']);
    expect(await rolesOf(dsB, alice)).toEqual(['sales.viewer']); // B untouched
    const ctxA = await contexts.load(alice, h.companyAId, dsA.manager);
    expect(ctxA.hasAtLeast('sales.order.create', 'editable')).toBe(true); // union: manager grants win
    expect((await memberships.findByUserAndCompany(alice, h.companyAId))?.roleKey).toBe('sales.manager'); // mirror = primary
    const noop = await mgmt.setRoles(A, h.companyAId, dsA, alice, ['sales.manager', 'sales.viewer']);
    expect(noop.changed).toBe(false);
    await mgmt.setRoles(A, h.companyAId, dsA, alice, []); // zero roles = sees nothing
    expect((await contexts.load(alice, h.companyAId, dsA.manager)).roleKeys).toEqual([]);
    await mgmt.setRoles(A, h.companyAId, dsA, alice, ['sales.manager']);
    expect((await memberships.findByUserAndCompany(alice, h.companyAId))?.authzVersion).toBeGreaterThan(1);
  });

  it('anti-elevation (risk-aware, F3): cannot change own roles; administration authority assigns NON-critical roles freely but roles reaching CRITICAL nodes only if you hold them explicitly; refusals are audited and change nothing', async () => {
    const carol = await mk('Carol Manager');
    const dave = await mk('Dave Target');
    await memberships.create({ userId: carol, companyId: h.companyAId, roleKey: 'people_manager' });
    await memberships.create({ userId: dave, companyId: h.companyAId, roleKey: 'sales.viewer' });
    // a Company-owned role that can ONLY manage members (no sales grants, no admin, nothing critical)
    const [role] = await dsA.query(`INSERT INTO roles ("key") VALUES ('people_manager') RETURNING id`);
    await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable')`, [role.id, COMPANY_MEMBERS_MANAGE_NODE]);
    await dsA.query(`INSERT INTO user_roles ("userId","roleId") VALUES ($1,$2)`, [carol, role.id]);
    await dsA.query(`INSERT INTO user_roles ("userId","roleId") SELECT $1, id FROM roles WHERE "key"='sales.viewer'`, [dave]);
    // a role that reaches a CRITICAL node
    const [crit] = await dsA.query(`INSERT INTO roles ("key") VALUES ('ops_critical') RETURNING id`);
    await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,'accounting.journal.reverse','editable')`, [crit.id]);
    const C = await actorOf(dsA, carol);
    const before = await rolesOf(dsA, dave);

    await expectCode(mgmt.setRoles(C, h.companyAId, dsA, carol, ['people_manager', 'sales.manager']), 'SELF_ROLE_CHANGE');
    await expectCode(mgmt.setRoles(C, h.companyAId, dsA, dave, ['sales.viewer', 'admin']), 'ROLE_EXCEEDS_GRANTOR'); // the legacy admin reaches every critical node
    await expectCode(mgmt.setRoles(C, h.companyAId, dsA, dave, ['sales.viewer', 'ops_critical']), 'ROLE_EXCEEDS_GRANTOR'); // explicit critical role
    await expectCode(mgmt.setRoles(C, h.companyAId, dsA, dave, ['no_such_role']), 'UNKNOWN_ROLE');
    expect(await rolesOf(dsA, dave)).toEqual(before); // nothing changed
    await mgmt.setRoles(C, h.companyAId, dsA, dave, ['sales.manager']); // non-critical: administration authority is enough
    expect(await rolesOf(dsA, dave)).toEqual(['sales.manager']);
    await mgmt.setRoles(C, h.companyAId, dsA, dave, ['sales.viewer', 'people_manager']); // she can also hand out her own role
    expect(await rolesOf(dsA, dave)).toEqual(['people_manager', 'sales.viewer']);
    // a member who ALREADY holds a critical role cannot be stripped of it by someone who does not hold it
    await dsA.query(`INSERT INTO user_roles ("userId","roleId") VALUES ($1,$2)`, [dave, crit.id]);
    await expectCode(mgmt.setRoles(C, h.companyAId, dsA, dave, ['sales.viewer', 'people_manager']), 'ROLE_EXCEEDS_GRANTOR');
    await dsA.query(`DELETE FROM user_roles WHERE "userId"=$1 AND "roleId"=$2`, [dave, crit.id]);
    const denied = await dsA.query(`SELECT count(*)::int n FROM audit_records WHERE result='denied' AND action LIKE 'role.assignment%'`);
    expect(denied[0].n).toBeGreaterThanOrEqual(3);
    const preview = await mgmt.assignableRoles(dsA, C);
    expect(preview.find((r) => r.key === 'admin')?.assignable).toBe(false);
    expect(preview.find((r) => r.key === 'ops_critical')?.assignable).toBe(false);
    expect(preview.find((r) => r.key === 'sales.manager')?.assignable).toBe(true);
    expect(preview.find((r) => r.key === 'people_manager')?.assignable).toBe(true);
  });

  it('last administrator: demote / suspend / remove are refused for the last active admin; with two admins exactly one of two concurrent removals wins', async () => {
    const A1 = await actorOf(dsA, adminA1);
    const A2 = await actorOf(dsA, adminA2);
    const B = await actorOf(dsB, adminB1);
    // Company B has ONE admin (adminB1): another admin-capable actor does not exist, so use the platform-style protection through a second admin first.
    const b2 = (await h.createUserWithAdminRoleIn('Admin B Two', h.companyBId)).id;
    const B2 = await actorOf(dsB, b2);
    await mgmt.setRoles(B, h.companyBId, dsB, b2, ['admin']); // no-op
    await mgmt.removeMember(B2, h.companyBId, dsB, adminB1); // B2 removes B1 -> B2 is now the last admin
    await expectCode(mgmt.setRoles(await actorOf(dsB, alice), h.companyBId, dsB, b2, []), 'ROLE_EXCEEDS_GRANTOR'); // sanity: removing the (critical-reaching) admin role needs explicit critical power
    // the last admin cannot be touched by anyone who could: demote/suspend/remove all refused
    await expectCode(mgmt.removeMember(B2, h.companyBId, dsB, b2), 'SELF_ROLE_CHANGE');
    const tmp = await mk('Temp Admin B');
    await memberships.create({ userId: tmp, companyId: h.companyBId, roleKey: 'admin' });
    await dsB.query(`INSERT INTO user_roles ("userId","roleId") SELECT $1, id FROM roles WHERE "key"='admin'`, [tmp]);
    const T = await actorOf(dsB, tmp);
    await mgmt.setStatus(B2, h.companyBId, dsB, tmp, 'suspended'); // B2 remains active admin; tmp suspended
    await expectCode(mgmt.setStatus(T, h.companyBId, dsB, b2, 'suspended'), 'LAST_ADMIN'); // tmp is suspended (not active): B2 would be the last ACTIVE admin
    await expectCode(mgmt.removeMember(T, h.companyBId, dsB, b2), 'LAST_ADMIN');
    await expectCode(mgmt.setRoles(T, h.companyBId, dsB, b2, ['sales.viewer']), 'LAST_ADMIN');
    expect((await memberships.findByUserAndCompany(b2, h.companyBId))?.status).toBe('active');
    // concurrency in Company A: two admins try to remove each other at the same time
    // Deterministic race: widen the window between the last-admin CHECK and the WRITE. Without the per-Company administration lock both
    // transactions pass the check inside this window and both removals succeed (zero admins); with it the second waits for the first to commit.
    const original = mgmt.assertAnotherActiveAdmin.bind(mgmt);
    const spy = jest.spyOn(mgmt, 'assertAnotherActiveAdmin').mockImplementation(async (...args) => {
      await original(...args);
      await new Promise((r) => setTimeout(r, 400));
    });
    const results = await Promise.allSettled([mgmt.removeMember(A1, h.companyAId, dsA, adminA2), mgmt.removeMember(A2, h.companyAId, dsA, adminA1)]);
    spy.mockRestore();
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter((r) => r.status === 'rejected' && (r.reason as CompanyUserError).code === 'LAST_ADMIN').length;
    expect(ok).toBe(1);
    expect(refused).toBe(1);
    const activeAdmins = (await memberships.findByCompany(h.companyAId)).filter((m) => m.status === 'active' && [adminA1, adminA2].includes(m.userId));
    expect(activeAdmins).toHaveLength(1); // never zero
    // restore a second admin in A for later tests
    const survivor = activeAdmins[0].userId;
    const removed = survivor === adminA1 ? adminA2 : adminA1;
    await memberships.create({ userId: removed, companyId: h.companyAId, roleKey: 'admin' });
    await dsA.query(`INSERT INTO user_roles ("userId","roleId") SELECT $1, id FROM roles WHERE "key"='admin' ON CONFLICT DO NOTHING`, [removed]);
  });

  it('suspension is enforced by CompanyContextGuard on the very next request; re-activation restores ONLY the roles still held (no new grant)', async () => {
    const eve = await mk('Eve Suspended');
    await memberships.create({ userId: eve, companyId: h.companyAId, roleKey: 'sales.viewer' });
    await dsA.query(`INSERT INTO user_roles ("userId","roleId") SELECT $1, id FROM roles WHERE "key"='sales.viewer'`, [eve]);
    const guard = new CompanyContextGuard(memberships, h.companies, h.connections);
    const call = () => guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ user: { id: eve, companyId: h.companyAId } }) }) } as never);
    await expect(call()).resolves.toBe(true);
    const A = await actorOf(dsA, (await memberships.findByCompany(h.companyAId)).find((m) => m.roleKey === 'admin' && m.status === 'active')!.userId);
    await mgmt.setStatus(A, h.companyAId, dsA, eve, 'suspended');
    await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    expect((await memberships.findByUserId(eve)).filter((m) => m.status === 'active')).toHaveLength(0);
    expect(await rolesOf(dsA, eve)).toEqual(['sales.viewer']); // roles kept while suspended, but unreachable
    await mgmt.setStatus(A, h.companyAId, dsA, eve, 'active');
    await expect(call()).resolves.toBe(true);
    expect(await rolesOf(dsA, eve)).toEqual(['sales.viewer']); // exactly what it was
    await mgmt.removeMember(A, h.companyAId, dsA, eve);
    await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    expect(await rolesOf(dsA, eve)).toEqual([]);
  });

  describe('invitations', () => {
    let A: CompanyActor;
    let adminOfA: string;
    beforeAll(async () => {
      adminOfA = (await memberships.findByCompany(h.companyAId)).find((m) => m.roleKey === 'admin' && m.status === 'active')!.userId;
      A = await actorOf(dsA, adminOfA);
    });

    it('creation response is IDENTICAL for an e-mail with an identity elsewhere and one with none; only a hash is stored; roles are anti-elevation checked', async () => {
      const knownElsewhere = (await users.findById(adminB1)).email; // identity exists (in Company B)
      const r1 = await invites.create(A, h.companyAId, dsA, { email: knownElsewhere, roleKeys: ['sales.viewer'] });
      const r2 = await invites.create(A, h.companyAId, dsA, { email: `brand.new.${randomUUID().slice(0, 6)}@f2.test`, roleKeys: ['sales.viewer'] });
      expect(Object.keys(r1).sort()).toEqual(Object.keys(r2).sort());
      expect(Object.keys(r1.invitation).sort()).toEqual(Object.keys(r2.invitation).sort());
      expect(r1.deliveryMode).toBe('manual');
      const rows = await cp.query(`SELECT "tokenHash" FROM company_invitations WHERE id=$1`, [r1.invitation.id]);
      expect(rows[0].tokenHash).toBe(hashInvitationToken(r1.token));
      expect(JSON.stringify(await cp.query(`SELECT * FROM company_invitations`))).not.toContain(r1.token); // the raw token is nowhere in the table
      expect(r1.token.length).toBeGreaterThanOrEqual(40);
      await expectCode(invites.create(A, h.companyAId, dsA, { email: 'x@f2.test', roleKeys: ['nope'] }), 'UNKNOWN_ROLE');
      await expectCode(invites.create(A, h.companyAId, dsA, { email: 'not-an-email' }), 'INVALID_INPUT');
      // an e-mail that is already a member of THIS Company is refused (own-directory fact only)
      await expectCode(invites.create(A, h.companyAId, dsA, { email: (await users.findById(alice)).email }), 'ALREADY_MEMBER');
      const carol = (await memberships.findByCompany(h.companyAId)).find((m) => m.roleKey === 'people_manager')!;
      const C = await actorOf(dsA, carol.userId);
      await expectCode(invites.create(C, h.companyAId, dsA, { email: 'y@f2.test', roleKeys: ['admin'] }), 'ROLE_EXCEEDS_GRANTOR');
    });

    it('existing identity accepts only when signed in as the invited e-mail; the token is single-use; wrong e-mail / unknown / replay all look the same', async () => {
      const frank = await mk('Frank Existing');
      const email = (await users.findById(frank)).email;
      const inv = await invites.create(A, h.companyAId, dsA, { email, roleKeys: ['sales.viewer'] });
      const prev = await invites.preview(inv.token);
      expect(prev).toMatchObject({ companyName: 'Company A', email });
      const mallory = await mk('Mallory Other');
      await expectCode(invites.acceptAsUser(mallory, inv.token), 'INVITATION_INVALID'); // someone else's token
      await expectCode(invites.preview('x'.repeat(43)), 'INVITATION_INVALID');
      expect((await memberships.findByUserAndCompany(mallory, h.companyAId))).toBeNull();
      const r = await invites.acceptAsUser(frank, inv.token);
      expect(r.companyId).toBe(h.companyAId);
      expect(await rolesOf(dsA, frank)).toEqual(['sales.viewer']);
      const m = await memberships.findByUserAndCompany(frank, h.companyAId);
      expect(m).toMatchObject({ status: 'active', roleKey: 'sales.viewer', invitedBy: adminOfA });
      await expectCode(invites.acceptAsUser(frank, inv.token), 'INVITATION_INVALID'); // replay
      await expectCode(invites.preview(inv.token), 'INVITATION_INVALID');
    });

    it('concurrent acceptance of one token: exactly one succeeds', async () => {
      const gina = await mk('Gina Racer');
      const inv = await invites.create(A, h.companyAId, dsA, { email: (await users.findById(gina)).email, roleKeys: ['sales.viewer'] });
      const rs = await Promise.allSettled([invites.acceptAsUser(gina, inv.token), invites.acceptAsUser(gina, inv.token), invites.acceptAsUser(gina, inv.token)]);
      expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await rolesOf(dsA, gina)).toEqual(['sales.viewer']);
    });

    it('a NEW identity is created only for an e-mail with no account, with no platform role; an existing account must sign in (no takeover)', async () => {
      const email = `newbie.${randomUUID().slice(0, 6)}@f2.test`;
      const inv = await invites.create(A, h.companyAId, dsA, { email, fullName: 'New Person', roleKeys: ['sales.viewer'] });
      await invites.acceptAsNewIdentity(inv.token, 'New Person', 'a-long-password');
      const created = await users.findByEmailInsensitive(email);
      expect(created?.status).toBe('active');
      expect(await rolesOf(dsA, created!.id)).toEqual(['sales.viewer']);
      expect(await cp.query(`SELECT 1 FROM user_roles WHERE "userId"=$1`, [created!.id])).toHaveLength(0); // no platform role
      const taken = await invites.create(A, h.companyAId, dsA, { email: (await users.findById(adminB1)).email, roleKeys: [] });
      await expectCode(invites.acceptAsNewIdentity(taken.token, 'Imposter', 'a-long-password'), 'ACCOUNT_EXISTS_SIGN_IN');
    });

    it('expiry, revoke and supersede: expired / revoked / replaced tokens are dead; revoke is scoped to the validated Company', async () => {
      const email = `exp.${randomUUID().slice(0, 6)}@f2.test`;
      const first = await invites.create(A, h.companyAId, dsA, { email, roleKeys: [] });
      const second = await invites.create(A, h.companyAId, dsA, { email, roleKeys: [] }); // supersedes
      await expectCode(invites.preview(first.token), 'INVITATION_INVALID');
      await expect(invites.preview(second.token)).resolves.toMatchObject({ email });
      // Company B's administrator cannot revoke Company A's invitation (404-shaped, scoped by the validated Company)
      await expectCode(invites.revoke(await actorOf(dsB, (await memberships.findByCompany(h.companyBId)).find((m) => m.status === 'active' && m.roleKey === 'admin')!.userId), h.companyBId, dsB, second.invitation.id), 'INVITATION_INVALID');
      await cp.query(`UPDATE company_invitations SET "expiresAt" = now() - interval '1 minute' WHERE id=$1`, [second.invitation.id]);
      await expectCode(invites.preview(second.token), 'INVITATION_INVALID');
      expect((await invites.list(h.companyAId)).find((i) => i.id === second.invitation.id)?.status).toBe('expired');
      const third = await invites.create(A, h.companyAId, dsA, { email, roleKeys: [] });
      await invites.revoke(A, h.companyAId, dsA, third.invitation.id);
      await expectCode(invites.preview(third.token), 'INVITATION_INVALID');
    });

    it('no automatic elevation: if the inviter lost the authority (or a role) before acceptance, the invitation is dead', async () => {
      const helen = await mk('Helen Late');
      const manager = await mk('Ivan Inviter');
      await memberships.create({ userId: manager, companyId: h.companyAId, roleKey: 'people_manager' });
      await dsA.query(`INSERT INTO user_roles ("userId","roleId") SELECT $1, id FROM roles WHERE "key"='people_manager'`, [manager]);
      const M = await actorOf(dsA, manager);
      const inv = await invites.create(M, h.companyAId, dsA, { email: (await users.findById(helen)).email, roleKeys: ['people_manager'] });
      await dsA.query(`DELETE FROM user_roles WHERE "userId"=$1`, [manager]); // inviter demoted
      await expectCode(invites.acceptAsUser(helen, inv.token), 'INVITATION_INVALID');
      expect(await memberships.findByUserAndCompany(helen, h.companyAId)).toBeNull();
    });
  });

  it('mirror reconciliation: a stale platform mirror is healed from the Company DB authority (never the other way round)', async () => {
    const ida = await mk('Ida Mirror');
    await memberships.create({ userId: ida, companyId: h.companyAId, roleKey: 'sales.viewer' });
    const A = await actorOf(dsA, (await memberships.findByCompany(h.companyAId)).find((m) => m.roleKey === 'admin' && m.status === 'active')!.userId);
    await mgmt.setRoles(A, h.companyAId, dsA, ida, ['sales.manager']);
    await cp.query(`UPDATE user_company_memberships SET "roleKey"='stale' WHERE "userId"=$1 AND "companyId"=$2`, [ida, h.companyAId]);
    const op = await ops.start(ida, h.companyAId, 'role_set', 'stale', null, { targetRoleKeys: ['sales.manager'] });
    await ops.markFailed(op.id, 'simulated mirror failure');
    const sched = new MembershipReconciliationScheduler(ops, memberships, h.connections, audit);
    await sched.runOnce();
    expect((await memberships.findByUserAndCompany(ida, h.companyAId))?.roleKey).toBe('sales.manager');
    expect(await rolesOf(dsA, ida)).toEqual(['sales.manager']); // authority untouched by the reconciler
  });

  it('audit: every F2 change is recorded in the Company chain (and the platform chain), and both hash chains still verify', async () => {
    const companyActions: Array<{ action: string }> = await dsA.query(`SELECT DISTINCT action FROM audit_records`);
    const set = companyActions.map((r) => r.action);
    for (const a of ['role.assigned', 'role.removed', 'membership.suspended', 'membership.reactivated', 'membership.removed', 'membership.invited', 'membership.accepted']) expect(set).toContain(a);
    const platformActions: Array<{ action: string }> = await cp.query(`SELECT DISTINCT action FROM audit_records`);
    expect(platformActions.map((r) => r.action)).toEqual(expect.arrayContaining(['company.membership.roles_changed', 'company.membership.suspended', 'company.membership.removed']));
    expect((await audit.verifyCompanyChain(dsA.manager)).valid).toBe(true);
    expect((await audit.verifyCompanyChain(dsB.manager)).valid).toBe(true);
    expect((await audit.verifyChain()).valid).toBe(true);
    // B's chain holds no A-side action about A's users
    const leaked = await dsB.query(`SELECT count(*)::int n FROM audit_records WHERE "resourceId"::text = ANY($1::text[])`, [[adminA1, adminA2]]);
    expect(leaked[0].n).toBe(0);
  });
});
