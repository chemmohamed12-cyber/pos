import { randomUUID } from 'crypto';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { DatabaseCredential } from '../database-registry/database-credential.entity';
import { CompanyContextGuard } from '../company/company-context.guard';
import { CompanyDatabaseNotActiveError } from '../database-registry/company-connection-manager.service';
import { ProvisioningFailedError } from './database-provisioning.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { buildProvisioningKit } from '../testing/saas-provisioning-kit';
import { Recorder, assertIsolatedInstance, databaseExists, dropDisposableDatabase, hashFile, residueOf } from '../testing/saas-characterization.helpers';

/**
 * WP-0.5d / CD-1 — TEST-ONLY characterization (requested by the CTO's CD-1 ruling:
 * "first a separate characterization of the ACTUAL behavior, then a unified lifecycle
 * decision; no code changes"). Three topics, kept apart from DP-9:
 *   1. provisioning-failure state,  2. the reactivation bypass,  3. decommission retention/teardown.
 * Real DatabaseProvisioningService / CompanyRegistryService / CompanyActivationService /
 * CompanyContextGuard on disposable databases (isolated instance). Core tag only (speed).
 */
describe('WP-0.5d / CD-1 characterization — provisioning failure, reactivation bypass, decommission retention (real-Postgres, isolated instance)', () => {
  jest.setTimeout(1_800_000);
  const rec = new Recorder();
  const PREFIX = 'wp05d';
  const DB_FAIL = 'daii_test_wp05d_failed';
  const DB_BYPASS = 'daii_test_wp05d_bypass';
  const sources = ['src/foundation/database-provisioning/database-provisioning.service.ts', 'src/foundation/company/company-status.ts', 'src/foundation/company/company-registry.service.ts', 'src/foundation/company/company-activation.service.ts', 'src/foundation/company/company-context.guard.ts', 'src/foundation/testing/saas-provisioning-kit.ts'];
  let h: TwoCompanyHarness;
  let kit: ReturnType<typeof buildProvisioningKit>;
  let before: Record<string, string>;
  let failedCompanyId: string;
  let validAdminId: string;

  const registryOf = (companyId: string) => h.controlPlane.getRepository(DatabaseRegistry).findOneOrFail({ where: { companyId } });
  const ghostAdmin = () => randomUUID(); // a UserId that does not exist → fails at stage "initial-admin"

  beforeAll(async () => {
    assertIsolatedInstance();
    before = Object.fromEntries(sources.map((s) => [s, hashFile(s)]));
    h = await setUpTwoCompanyHarness({ namePrefix: PREFIX, roleModuleCodes: [] });
    kit = buildProvisioningKit(h);
    validAdminId = (await h.users.create({ fullName: 'WP05d Valid Admin', email: 'wp05d-valid-admin@test.local' })).id;
  });

  afterAll(async () => {
    await h.teardown();
    for (const db of [DB_FAIL, DB_BYPASS]) await dropDisposableDatabase(db);
    rec.record('sourceHashesBefore', before);
    rec.record('sourceHashesAfter', Object.fromEntries(sources.map((s) => [s, hashFile(s)])));
    rec.record('residue', await residueOf('daii_test_wp05d'));
    rec.flush('wp05d');
    expect(await residueOf('daii_test_wp05d')).toEqual([]);
  });

  it('1. FAILURE STATE — a provisioning failure leaves the Company row PROVISIONING while the registry is FAILED; the Company is hidden from the visible list', async () => {
    failedCompanyId = (await kit.createCompanyRow('WP05d Failed')).id;
    await expect(kit.provisionInto({ companyId: failedCompanyId, databaseName: DB_FAIL, initialAdminUserId: ghostAdmin(), tags: ['core'] })).rejects.toBeInstanceOf(ProvisioningFailedError);

    const company = await h.companies.findById(failedCompanyId);
    const registry = await registryOf(failedCompanyId);
    const visibleIds = (await kit.companyRegistry.listVisible('installation')).map((c) => c.id);
    rec.record('afterFailure', { companyStatus: company?.status, registryStatus: registry.status, inVisibleList: visibleIds.includes(failedCompanyId), foundById: !!company });
    expect(company?.status).toBe('PROVISIONING');
    expect(registry.status).toBe('FAILED');
    expect(visibleIds).not.toContain(failedCompanyId);
  });

  it('1b. RESUME (service level) — calling provision() again for the same Company with a valid administrator completes it (READY / ACTIVE); the HTTP create route has no such path (it always creates a new Company row — code fact, not tested here)', async () => {
    const result = await kit.provisionInto({ companyId: failedCompanyId, databaseName: DB_FAIL, initialAdminUserId: validAdminId, tags: ['core'], reuseDatabase: true });
    expect(result.readyMarked).toBe(true);
    expect((await h.companies.findById(failedCompanyId))?.status).toBe('READY');
    expect((await registryOf(failedCompanyId)).status).toBe('ACTIVE');
    expect((await kit.companyRegistry.listVisible('installation')).map((c) => c.id)).toContain(failedCompanyId);
  });

  it('2. REACTIVATION BYPASS — reactivate() on a Company whose database failed moves it PROVISIONING → READY while the registry stays FAILED; the registry check still refuses access', async () => {
    const bypassId = (await kit.createCompanyRow('WP05d Bypass')).id;
    await expect(kit.provisionInto({ companyId: bypassId, databaseName: DB_BYPASS, initialAdminUserId: ghostAdmin(), tags: ['core'] })).rejects.toBeInstanceOf(ProvisioningFailedError);
    expect((await h.companies.findById(bypassId))?.status).toBe('PROVISIONING');

    const reactivated = await kit.activation.reactivate(bypassId); // CURRENT behavior: allowed
    expect(reactivated.status).toBe('READY');
    expect((await registryOf(bypassId)).status).toBe('FAILED');
    rec.record('bypass', { companyStatus: 'READY', registryStatus: 'FAILED', listedAsVisible: (await kit.companyRegistry.listVisible('installation')).map((c) => c.id).includes(bypassId) });

    const member = await h.users.create({ fullName: 'WP05d Bypass Member', email: 'wp05d-bypass-member@test.local' });
    await h.memberships.create({ userId: member.id, companyId: bypassId, roleKey: 'admin' });
    const guard = new CompanyContextGuard(h.memberships, h.companies, h.connections);
    const req = { user: { id: member.id, companyId: bypassId } };
    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never)).rejects.toBeInstanceOf(CompanyDatabaseNotActiveError);
  });

  it('3. DECOMMISSION RETENTION — after suspend → decommission the physical database, its credential, the registry row and the memberships are all STILL there (no teardown, no retention policy)', async () => {
    const memberBefore = (await h.memberships.findByCompany(failedCompanyId)).length;
    await kit.activation.suspend(failedCompanyId);
    await kit.activation.decommission(failedCompanyId);

    const registry = await registryOf(failedCompanyId);
    const credentialRows = await h.controlPlane.getRepository(DatabaseCredential).count({ where: { databaseRegistryId: registry.id } as never });
    const stillReachable = await h.connections.getDataSource(failedCompanyId).then((ds) => ds.query(`SELECT count(*)::int AS n FROM "roles"`)).then((r) => r[0].n).catch((e: Error) => `error: ${e.message}`);
    rec.record('afterDecommission', {
      companyStatus: (await h.companies.findById(failedCompanyId))?.status,
      physicalDatabaseExists: await databaseExists(DB_FAIL),
      registryStatus: registry.status,
      credentialRows: credentialRows,
      memberships: (await h.memberships.findByCompany(failedCompanyId)).length,
      databaseStillReachableThroughConnectionManager: stillReachable,
    });
    expect((await h.companies.findById(failedCompanyId))?.status).toBe('DECOMMISSIONED');
    expect(await databaseExists(DB_FAIL)).toBe(true);
    expect(registry.status).toBe('ACTIVE');
    expect(credentialRows).toBeGreaterThan(0);
    expect((await h.memberships.findByCompany(failedCompanyId)).length).toBe(memberBefore);
    expect(typeof stillReachable).toBe('number');
  });
});
