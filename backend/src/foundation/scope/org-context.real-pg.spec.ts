import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { AccessScopeService } from './access-scope.service';
import { OrgContextService } from './org-context.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { CompanyScopedRequest } from '../company/company-context.guard';

/**
 * Org engine Stage 3 (real PostgreSQL) — the server-side organizational context resolver on top of the REAL scope infrastructure (memberships, explicit grants,
 * descendants, the administrator's unrestricted reach): a client-provided branch is only a proposal, validated per Company and per caller scope; branchless Companies
 * are unaffected; an unrestricted administrator must still choose; a single reachable branch is used; there is never a silent default.
 */
describe('OrgContextService — branch resolution on the real scope model (two Companies)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let dsA: DataSource;
  let dsB: DataSource;
  let ctx: OrgContextService;
  let admin: string;
  const ids = { root: randomUUID(), x: randomUUID(), y: randomUUID(), dept: randomUUID(), bx: randomUUID() };
  const users = { memberX: randomUUID(), grantXY: randomUUID(), deptOnly: randomUUID(), none: randomUUID() };

  const req = (userId: string, ds: DataSource) => ({ user: { id: userId, email: 'x@test.local', companyId: 'c' }, companyContext: { companyId: 'c', dataSource: ds } }) as unknown as CompanyScopedRequest;
  const unit = (ds: DataSource, id: string, type: string, name: string, parent: string | null, status = 'active') =>
    ds.query(`INSERT INTO org_units (id, type, name, "parentId", status) VALUES ($1,$2,$3,$4,$5)`, [id, type, name, parent, status]);

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'org_context', extraCompanyTags: ['sales', 'inventory'], roleModuleCodes: ['sales', 'inventory'] });
    dsA = await h.connections.getDataSource(h.companyAId);
    dsB = await h.connections.getDataSource(h.companyBId);
    const scopes = new AccessScopeService(dsA, new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole)));
    jest.spyOn(scopes, 'forRequest').mockImplementation((r) => scopes.resolve(r.user!.id, r.companyContext!.dataSource.manager));
    ctx = new OrgContextService(scopes);
    admin = (await h.createUserWithAdminRoleIn('Ctx Admin A', h.companyAId)).id;
  });
  afterAll(async () => h.teardown().catch(() => undefined));

  it('a Company with no branches: nothing required, nothing invented (branchless behaviour preserved)', async () => {
    await unit(dsA, ids.root, 'company', 'Root', null);
    expect(await ctx.resolveBranch(req(admin, dsA), { required: true })).toBeNull();
    expect(await ctx.resolveBranch(req(admin, dsA))).toBeNull();
  });

  it('with branches: the unrestricted administrator must still choose; an explicit valid choice is returned', async () => {
    await unit(dsA, ids.x, 'branch', 'X', ids.root);
    await unit(dsA, ids.y, 'branch', 'Y', ids.root);
    await unit(dsA, ids.dept, 'department', 'D', ids.x);
    await expect(ctx.resolveBranch(req(admin, dsA), { required: true })).rejects.toThrow(/Select the branch/i);
    expect(await ctx.resolveBranch(req(admin, dsA), { required: true, requested: ids.y })).toBe(ids.y);
    expect(await ctx.resolveBranch(req(admin, dsA), { required: false })).toBeNull(); // not required: no stamp, no default
  });

  it('scoped callers: membership / explicit grant define the reachable branches; exactly one -> used; several -> must choose; none -> refused', async () => {
    await dsA.query(`INSERT INTO org_memberships ("userId","orgUnitId") VALUES ($1,$2)`, [users.memberX, ids.x]);
    await dsA.query(`INSERT INTO access_scopes ("userId","orgUnitId","includeDescendants") VALUES ($1,$2,true),($1,$3,true)`, [users.grantXY, ids.x, ids.y]);
    await dsA.query(`INSERT INTO org_memberships ("userId","orgUnitId") VALUES ($1,$2)`, [users.deptOnly, ids.dept]);
    expect(await ctx.resolveBranch(req(users.memberX, dsA), { required: true })).toBe(ids.x);
    await expect(ctx.resolveBranch(req(users.grantXY, dsA), { required: true })).rejects.toThrow(/Select the branch/i);
    expect(await ctx.resolveBranch(req(users.grantXY, dsA), { required: true, requested: ids.y })).toBe(ids.y);
    await expect(ctx.resolveBranch(req(users.none, dsA), { required: true })).rejects.toThrow(/No branch is available/i);
    await expect(ctx.resolveBranch(req(users.deptOnly, dsA), { required: true })).rejects.toThrow(/No branch is available/i); // a department-only scope does not reach the branch
  });

  it('a requested branch outside the caller scope is a 404 (never 403); a client cannot widen its own scope by naming a branch', async () => {
    await expect(ctx.resolveBranch(req(users.memberX, dsA), { requested: ids.y })).rejects.toThrow(/Not Found/i);
    await expect(ctx.resolveBranch(req(users.none, dsA), { requested: ids.x })).rejects.toThrow(/Not Found/i);
  });

  it('even the administrator cannot name a non-branch, an archived branch, a malformed id or an unknown id', async () => {
    await unit(dsA, ids.bx, 'branch', 'Old', ids.root, 'archived');
    await expect(ctx.resolveBranch(req(admin, dsA), { requested: ids.dept })).rejects.toThrow(/not a branch/i);
    await expect(ctx.resolveBranch(req(admin, dsA), { requested: ids.bx })).rejects.toThrow(/archived/i);
    await expect(ctx.resolveBranch(req(admin, dsA), { requested: 'nope' })).rejects.toThrow(/not valid/i);
    await expect(ctx.resolveBranch(req(admin, dsA), { requested: randomUUID() })).rejects.toThrow(/Not Found/i);
  });

  it('cross-Company: a branch of Company B is unknown in Company A, and A never sees B’s units', async () => {
    const bBranch = randomUUID();
    await unit(dsB, bBranch, 'branch', 'Beta', null);
    await expect(ctx.resolveBranch(req(admin, dsA), { requested: bBranch })).rejects.toThrow(/Not Found/i);
  });

  it('inheritBranch: a child document takes its parent’s branch; a conflicting request is refused', () => {
    expect(ctx.inheritBranch(ids.x, undefined)).toBe(ids.x);
    expect(ctx.inheritBranch(ids.x, ids.x)).toBe(ids.x);
    expect(() => ctx.inheritBranch(ids.x, ids.y)).toThrow(/match the parent/i);
    expect(ctx.inheritBranch(null, null)).toBeNull();
  });
});
