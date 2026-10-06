import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { assertDataSourceNeverRequestedFor, assertDistinctCachedDataSources, setUpTwoCompanyHarness, TwoCompanyHarness } from './two-company-real-pg-harness';

/**
 * Area 21 Retrofit Preparation (2026-09-25). Proves the harness itself
 * works end to end — real Postgres, both Companies, both Users — using
 * the one already-compliant mechanism this whole program has already
 * proven repeatedly (`AuthorizationService.getRoleKeysForUser` via a
 * validated Company `manager`), so future Area 21 controller proofs start
 * from a KNOWN-GOOD harness, not an unverified one.
 */
describe('setUpTwoCompanyHarness — self-test (2026-09-25)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'harness_selftest' });
  });

  afterAll(async () => {
    await h.teardown();
  });

  it('A -> A: a user with an admin grant in Company A resolves it via Company A\'s own connection', async () => {
    const userA = await h.createUserWithAdminRoleIn('Harness User A', h.companyAId);
    const dsA = await h.connections.getDataSource(h.companyAId);
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));

    const roles = await authorization.getRoleKeysForUser(userA.id, dsA.manager);
    expect(roles).toContain('admin');
  });

  it('A -> B: the same user has no roles when resolved via Company B\'s connection (cross-company denial)', async () => {
    const userA = await h.createUserWithAdminRoleIn('Harness User A2', h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const authorization = new AuthorizationService(dsB.getRepository(Role), dsB.getRepository(UserRole));

    const roles = await authorization.getRoleKeysForUser(userA.id, dsB.manager);
    expect(roles).toEqual([]);
  });

  it('B -> B: a Company-B-only user resolves correctly via Company B\'s own connection', async () => {
    const userB = await h.createUserWithAdminRoleIn('Harness User B', h.companyBId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const authorization = new AuthorizationService(dsB.getRepository(Role), dsB.getRepository(UserRole));

    const roles = await authorization.getRoleKeysForUser(userB.id, dsB.manager);
    expect(roles).toContain('admin');
  });

  it('revoked membership: removing the Membership row means no future grant exists for that user in that Company', async () => {
    const userA = await h.createUserWithAdminRoleIn('Harness User Revoked', h.companyAId);
    await h.memberships.revoke(userA.id, h.companyAId);

    const stillMember = await h.memberships.findByUserAndCompany(userA.id, h.companyAId);
    expect(stillMember).toBeNull();
  });

  it('missing company context: a user with zero memberships resolves to zero companies via /memberships/mine-style lookup', async () => {
    const userNone = await h.users.create({ fullName: 'Harness User None', email: 'harness-none@test.local' });
    const rows = await h.memberships.findByUserId(userNone.id);
    expect(rows).toEqual([]);
  });

  it('two distinct, separately-cached DataSources exist for A and B (isolation contract intact)', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect(dsA).not.toBe(dsB);
    expect(dsA.options.database).toBe(h.companyADbName);
    expect(dsB.options.database).toBe(h.companyBDbName);
  });

  it('assertDistinctCachedDataSources: passes for the real harness (self-test of the helper)', async () => {
    await expect(assertDistinctCachedDataSources(h)).resolves.toBeUndefined();
  });

  it('assertDataSourceNeverRequestedFor: passes when the forbidden Company is never requested, and restores the original method afterward', async () => {
    await h.connections.getDataSource(h.companyAId);
    await expect(
      assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
        await h.connections.getDataSource(h.companyAId);
      }),
    ).resolves.toBeUndefined();

    // the wrapper must be fully unwrapped afterward — a real, unwrapped call still works
    const dsA = await h.connections.getDataSource(h.companyAId);
    expect(dsA.options.database).toBe(h.companyADbName);
  });

  it('assertDataSourceNeverRequestedFor: fails when the forbidden Company IS requested, and still restores the original method', async () => {
    await expect(
      assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
        await h.connections.getDataSource(h.companyBId);
      }),
    ).rejects.toThrow(/never be called with forbidden Company id/);

    const dsB = await h.connections.getDataSource(h.companyBId);
    expect(dsB.options.database).toBe(h.companyBDbName);
  });
});
