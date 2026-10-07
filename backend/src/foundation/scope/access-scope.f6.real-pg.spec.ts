import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { AccessScopeService } from './access-scope.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { WarehouseScopeGuard } from './warehouse-scope.guard';
import { WarehouseScoped } from './warehouse-scope.decorator';

/**
 * Authorization Foundation F6 — real-Postgres proof of the SCOPE primitives (Blueprint §9, verification V7):
 *  two branches, two warehouses (+ an operational custody sub-location and an unlinked warehouse), scoped users with memberships, explicit grants, descendants on/off,
 *  an "All company" grant, the unrestricted administrator · deny = 404 · unlinked = visible to everyone · Company A's scope never reaches Company B ·
 *  grants are contained by the actor's own scope · `WarehouseScopeGuard` decisions.
 */
describe('F6 — access scope primitives (real Postgres, two Companies)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let dsA: DataSource;
  let dsB: DataSource;
  let scopes: AccessScopeService;
  let admin: string;

  const U = () => randomUUID();
  const ids = { root: U(), branchX: U(), branchY: U(), deptX: U(), whUnitX: U(), whUnitY: U(), W1: U(), W2: U(), W3: U(), W1custody: U() };
  const users = { memberX: U(), grantY: U(), exactX: U(), allCompany: U(), none: U() };

  const unit = (ds: DataSource, id: string, type: string, name: string, parentId: string | null) =>
    ds.query(`INSERT INTO org_units (id, type, name, "parentId") VALUES ($1, $2, $3, $4)`, [id, type, name, parentId]);
  const wh = (ds: DataSource, id: string, code: string, orgUnitId: string | null, parent: string | null = null, kind = 'main') =>
    ds.query(`INSERT INTO warehouses (id, code, name, "orgUnitId", "parentWarehouseId", kind, status) VALUES ($1, $2, $2, $3, $4, $5, 'active')`, [id, code, orgUnitId, parent, kind]);

  const visibleCodes = async (userId: string) => {
    const scope = await scopes.resolve(userId, dsA.manager);
    const v = await scopes.visibleWarehouseIds(scope, dsA.manager);
    const rows: Array<{ id: string; code: string }> = await dsA.query(`SELECT id, code FROM warehouses ORDER BY code`);
    return v === 'ALL' ? ['ALL'] : rows.filter((r) => v.includes(r.id)).map((r) => r.code);
  };

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'f6_scope', extraCompanyTags: ['sales', 'inventory'], roleModuleCodes: ['sales', 'inventory'] });
    dsA = await h.connections.getDataSource(h.companyAId);
    dsB = await h.connections.getDataSource(h.companyBId);
    scopes = new AccessScopeService(dsA, new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole)));
    admin = (await h.createUserWithAdminRoleIn('F6 Admin A', h.companyAId)).id;

    await unit(dsA, ids.root, 'company', 'Root', null);
    await unit(dsA, ids.branchX, 'branch', 'Branch X', ids.root);
    await unit(dsA, ids.branchY, 'branch', 'Branch Y', ids.root);
    await unit(dsA, ids.deptX, 'department', 'Dept X', ids.branchX);
    await unit(dsA, ids.whUnitX, 'warehouse', 'WH Unit X', ids.branchX);
    await unit(dsA, ids.whUnitY, 'warehouse', 'WH Unit Y', ids.branchY);
    await wh(dsA, ids.W1, 'W1', ids.whUnitX); // under branch X
    await wh(dsA, ids.W2, 'W2', ids.whUnitY); // under branch Y
    await wh(dsA, ids.W3, 'W3', null); // unlinked = unscoped
    await wh(dsA, ids.W1custody, 'W1-VEH', null, ids.W1, 'operational'); // custody sub-location of W1: inherits W1's unit

    await dsA.query(`INSERT INTO org_memberships ("userId", "orgUnitId") VALUES ($1, $2)`, [users.memberX, ids.branchX]); // belongs to branch X (scope source kept for compatibility)
    await dsA.query(`INSERT INTO access_scopes ("userId", "orgUnitId", "includeDescendants") VALUES ($1, $2, true)`, [users.grantY, ids.branchY]);
    await dsA.query(`INSERT INTO access_scopes ("userId", "orgUnitId", "includeDescendants") VALUES ($1, $2, false)`, [users.exactX, ids.branchX]); // the branch itself, NOT its children
    await dsA.query(`INSERT INTO access_scopes ("userId", "orgUnitId", "includeDescendants") VALUES ($1, $2, true)`, [users.allCompany, ids.root]);
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('f6 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  it('the administrator is unrestricted; a user with no scope sees only unlinked warehouses', async () => {
    expect((await scopes.resolve(admin, dsA.manager)).unrestricted).toBe(true);
    expect(await visibleCodes(admin)).toEqual(['ALL']);
    expect(await visibleCodes(users.none)).toEqual(['W3']); // W1 / W2 are linked to units the user cannot reach; the custody sub-location inherits W1's link
  });

  it('a membership is a scope source with descendants (zero behaviour change for ADR-031 consumers); the custody sub-location inherits its parent warehouse', async () => {
    expect(await visibleCodes(users.memberX)).toEqual(['W1', 'W1-VEH', 'W3']);
    const scope = await scopes.resolve(users.memberX, dsA.manager);
    expect(scope.unitIds.has(ids.deptX) && scope.unitIds.has(ids.whUnitX) && scope.unitIds.has(ids.branchX)).toBe(true);
    expect(scope.unitIds.has(ids.branchY)).toBe(false);
  });

  it('an explicit grant works like a membership; includeDescendants=false stops at the unit itself', async () => {
    expect(await visibleCodes(users.grantY)).toEqual(['W2', 'W3']);
    const exact = await scopes.resolve(users.exactX, dsA.manager);
    expect(exact.unitIds.has(ids.branchX)).toBe(true);
    expect(exact.unitIds.has(ids.whUnitX)).toBe(false); // children excluded
    expect(await visibleCodes(users.exactX)).toEqual(['W3']); // W1 is linked to the CHILD unit, which this grant does not include
  });

  it('the "All company" grant (root, with descendants) reaches every unit', async () => {
    expect(await visibleCodes(users.allCompany)).toEqual(['W1', 'W1-VEH', 'W2', 'W3']);
  });

  it('assertWarehouse: in scope passes, out of scope is a 404 (never 403), unlinked and unknown warehouses are not a scope matter', async () => {
    const x = await scopes.resolve(users.memberX, dsA.manager);
    await expect(scopes.assertWarehouse(x, ids.W1, dsA.manager)).resolves.toBeUndefined();
    await expect(scopes.assertWarehouse(x, ids.W1custody, dsA.manager)).resolves.toBeUndefined();
    await expect(scopes.assertWarehouse(x, ids.W3, dsA.manager)).resolves.toBeUndefined();
    await expect(scopes.assertWarehouse(x, ids.W2, dsA.manager)).rejects.toBeInstanceOf(NotFoundException);
    await expect(scopes.assertWarehouse(x, randomUUID(), dsA.manager)).resolves.toBeUndefined();
  });

  it("Company A's scope never reaches Company B: B has no such units, and the same user id resolves to nothing there", async () => {
    const asInB = new AccessScopeService(dsB, new AuthorizationService(dsB.getRepository(Role), dsB.getRepository(UserRole)));
    const scope = await asInB.resolve(users.memberX, dsB.manager);
    expect(scope.unrestricted).toBe(false);
    expect(scope.unitIds.size).toBe(0);
    const bRows: unknown[] = await dsB.query(`SELECT 1 FROM access_scopes WHERE "userId" = $1`, [users.grantY]);
    expect(bRows).toHaveLength(0);
  });

  it('describe(): names the accessible units and splits visible / hidden warehouses (the Effective Access Preview)', async () => {
    const d = await scopes.describe(users.grantY, dsA.manager);
    expect(d.unrestricted).toBe(false);
    expect(d.units.map((u) => u.name).sort()).toEqual(['Branch Y', 'WH Unit Y']);
    expect(d.warehouses!.visible.map((w) => w.code)).toEqual(['W2', 'W3']);
    expect(d.warehouses!.hidden.map((w) => w.code)).toEqual(['W1', 'W1-VEH']);
    expect((await scopes.describe(admin, dsA.manager)).warehouses!.hidden).toEqual([]);
  });

  it('replaceGrants: contained by the actor\'s own scope; the administrator may grant anything; removal is always allowed; unknown units are refused', async () => {
    const actorX = await scopes.resolve(users.memberX, dsA.manager);
    const target = U();
    await expect(scopes.replaceGrants(actorX, target, [{ orgUnitId: ids.branchY, includeDescendants: true }], users.memberX, dsA.manager)).rejects.toBeInstanceOf(NotFoundException); // Y is outside X's scope
    await expect(scopes.replaceGrants(actorX, target, [{ orgUnitId: randomUUID(), includeDescendants: true }], users.memberX, dsA.manager)).rejects.toMatchObject({ status: 400 });
    const ok = await scopes.replaceGrants(actorX, target, [{ orgUnitId: ids.deptX, includeDescendants: true }], users.memberX, dsA.manager); // inside X
    expect(ok.after).toEqual([{ orgUnitId: ids.deptX, includeDescendants: true }]);
    const adminScope = await scopes.resolve(admin, dsA.manager);
    const big = await scopes.replaceGrants(adminScope, target, [{ orgUnitId: ids.root, includeDescendants: true }, { orgUnitId: ids.branchY, includeDescendants: false }], admin, dsA.manager);
    expect(big.before).toEqual([{ orgUnitId: ids.deptX, includeDescendants: true }]);
    expect(big.after).toHaveLength(2);
    // a scoped actor may NARROW or REMOVE what the target holds even where the unit is outside the actor's scope
    const narrowed = await scopes.replaceGrants(actorX, target, [], users.memberX, dsA.manager);
    expect(narrowed.after).toEqual([]);
    expect(await scopes.listGrants(target, dsA.manager)).toHaveLength(0);
  });

  describe('WarehouseScopeGuard', () => {
    const reflector = new Reflector();
    class Ctl {
      @WarehouseScoped({ query: 'warehouseId' })
      byQuery() {}
      @WarehouseScoped({ recordOf: 'warehouses', param: 'id' })
      byRecord() {}
      @WarehouseScoped({ body: 'warehouseId' }, { body: 'destinationWarehouseId' })
      transfer() {}
      noDeclaration() {}
    }
    const run = async (userId: string, handler: keyof Ctl, req: Record<string, unknown>) => {
      const guard = new WarehouseScopeGuard(reflector, scopes);
      const ctx = {
        getHandler: () => Ctl.prototype[handler],
        getClass: () => Ctl,
        switchToHttp: () => ({ getRequest: () => ({ user: { id: userId }, companyContext: { companyId: h.companyAId, dataSource: dsA }, query: {}, params: {}, body: {}, ...req }) }),
      };
      return guard.canActivate(ctx as never);
    };

    it('query / path-record / body sources: in scope passes, out of scope is a 404; the unrestricted administrator always passes', async () => {
      await expect(run(users.memberX, 'byQuery', { query: { warehouseId: ids.W1 } })).resolves.toBe(true);
      await expect(run(users.memberX, 'byQuery', { query: { warehouseId: ids.W2 } })).rejects.toBeInstanceOf(NotFoundException);
      await expect(run(users.memberX, 'byRecord', { params: { id: ids.W2 } })).rejects.toBeInstanceOf(NotFoundException);
      await expect(run(users.memberX, 'byRecord', { params: { id: ids.W1custody } })).resolves.toBe(true);
      await expect(run(admin, 'byQuery', { query: { warehouseId: ids.W2 } })).resolves.toBe(true);
    });

    it('a transfer needs BOTH warehouses in scope', async () => {
      await expect(run(users.memberX, 'transfer', { body: { warehouseId: ids.W1, destinationWarehouseId: ids.W3 } })).resolves.toBe(true);
      await expect(run(users.memberX, 'transfer', { body: { warehouseId: ids.W1, destinationWarehouseId: ids.W2 } })).rejects.toBeInstanceOf(NotFoundException);
      await expect(run(users.allCompany, 'transfer', { body: { warehouseId: ids.W1, destinationWarehouseId: ids.W2 } })).resolves.toBe(true);
    });

    it('fails open only on DATA (absent / non-UUID ids are left to the DTO and the handler), closed on structure (no Company context)', async () => {
      await expect(run(users.none, 'byQuery', {})).resolves.toBe(true); // no warehouse addressed
      await expect(run(users.none, 'byQuery', { query: { warehouseId: 'not-a-uuid' } })).resolves.toBe(true); // the DTO/pipe rejects it with 400
      await expect(run(users.none, 'noDeclaration', {})).resolves.toBe(true); // an undeclared route is not this guard's concern (the coverage spec catches omissions)
      const guard = new WarehouseScopeGuard(reflector, scopes);
      const bare = { getHandler: () => Ctl.prototype.byQuery, getClass: () => Ctl, switchToHttp: () => ({ getRequest: () => ({ user: { id: users.none }, query: { warehouseId: ids.W1 } }) }) };
      await expect(guard.canActivate(bare as never)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
