import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { LimitService } from './limit.service';
import { LimitController } from './limit.controller';
import { LimitRegistrySeeder } from './limit-registry.seeder';
import { LimitProfile } from './limit-profile.entity';
import { LimitUsageCounter } from './limit-usage-counter.entity';
import { AuditRecord } from '../audit/audit-record.entity';
import { AuditService } from '../audit/audit.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { AuthorizationService } from '../authorization/authorization.service';
import { RolePermission } from '../permission/role-permission.entity';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { PlatformGuard } from '../platform/platform.guard';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { Recorder, assertIsolatedInstance, dbConfig, hashFile, residueOf } from '../testing/saas-characterization.helpers';

/**
 * WP-0.5b — TEST-ONLY characterization (CTO-authorized, 2026-10-05).
 * Question (Dossier F-6, previously "code-reading only"): where do `/limits` permission
 * checks and profile edits actually land, and does a platform limit edit constrain a
 * Company? Real LimitService / LimitController / PermissionGuard / PermissionService /
 * AuthorizationService on disposable real-Postgres databases (isolated instance).
 * No production code changed; unknowns are RECORDED.
 */
describe('WP-0.5b characterization — /limits scope and Company limit editability (real-Postgres, isolated instance)', () => {
  jest.setTimeout(900_000);
  const rec = new Recorder();
  const PREFIX = 'wp05b_limits';
  const KEY = 'sales.max_customers';
  const sources = ['src/foundation/limit-engine/limit.service.ts', 'src/foundation/limit-engine/limit.controller.ts', 'src/foundation/platform/platform.guard.ts', 'src/foundation/authorization/authorization-context.service.ts', 'src/foundation/testing/two-company-real-pg-harness.ts'];
  let h: TwoCompanyHarness;
  let platformDs: DataSource;
  let limits: LimitService;
  let controller: LimitController;
  let guard: PlatformGuard;
  let platformAdminId: string;
  let companyAdminId: string;
  let before: Record<string, string>;

  const ctxFor = (userId: string, companyContext?: { dataSource: DataSource }) =>
    ({
      getHandler: () => LimitController.prototype.setProfile,
      getClass: () => LimitController,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: userId }, companyContext }) }),
    }) as never;

  beforeAll(async () => {
    assertIsolatedInstance();
    before = Object.fromEntries(sources.map((s) => [s, hashFile(s)]));
    h = await setUpTwoCompanyHarness({ namePrefix: PREFIX, roleModuleCodes: [] });
    platformDs = new DataSource({
      type: 'postgres',
      ...dbConfig(`daii_test_${PREFIX}_control_plane`),
      synchronize: false,
      logging: false,
      entities: [Role, UserRole, RolePermission, LimitProfile, LimitUsageCounter, AuditRecord],
    });
    await platformDs.initialize();

    const audit = new AuditService(platformDs);
    limits = new LimitService(platformDs, new LimitRegistrySeeder(platformDs, audit), audit);
    controller = new LimitController(limits);
    const authorization = new AuthorizationService(platformDs.getRepository(Role), platformDs.getRepository(UserRole));
    // F4 (2026-10-07): the /limits routes are PLATFORM routes — `PlatformGuard` + `@RequirePlatform('platform.limit.edit')` (legacy node `core.limit.edit` kept as an alias).
    guard = new PlatformGuard(new Reflector(), new AuthorizationContextService(platformDs));

    const platformAdmin = await h.users.create({ fullName: 'WP05b Platform Admin', email: 'wp05b-platform-admin@test.local' });
    platformAdminId = platformAdmin.id;
    await authorization.assignRole(platformAdminId, 'admin');
    companyAdminId = (await h.createUserWithAdminRoleIn('WP05b Company A Admin', h.companyAId)).id;
  });

  afterAll(async () => {
    if (platformDs?.isInitialized) await platformDs.destroy();
    await h.teardown();
    rec.record('sourceHashesBefore', before);
    rec.record('sourceHashesAfter', Object.fromEntries(sources.map((s) => [s, hashFile(s)])));
    rec.record('residue', await residueOf(`daii_test_${PREFIX}`));
    rec.flush('wp05b');
    expect(await residueOf(`daii_test_${PREFIX}`)).toEqual([]);
  });

  it('platform `admin` passes the /limits edit guard with NO Company context (platform authority evaluated on the platform database)', async () => {
    await expect(guard.canActivate(ctxFor(platformAdminId))).resolves.toBe(true);
  });

  it('a Company A administrator is DENIED the /limits edit guard as the route is actually wired (no Company context → evaluated on the platform database); with Company A\'s context the outcome is RECORDED', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await expect(guard.canActivate(ctxFor(companyAdminId))).rejects.toBeInstanceOf(ForbiddenException);
    // Not how the route is wired (the controller has no CompanyContextGuard) — recorded because the Company
    // `admin` role is seeded by the core migrations and may itself hold `core.limit`.
    // F4: the platform guard never reads a Company database, so supplying a Company context cannot change the outcome.
    const withContext = await guard.canActivate(ctxFor(companyAdminId, { dataSource: dsA })).then(() => 'allowed', () => 'denied');
    expect(withContext).toBe('denied');
    const adminNodes = (await dsA.query(`SELECT rp."nodeKey" FROM "role_permissions" rp JOIN "roles" r ON r.id = rp."roleId" WHERE r."key" = 'admin' AND rp."nodeKey" LIKE 'core.%' ORDER BY rp."nodeKey"`)).map((r: { nodeKey: string }) => r.nodeKey);
    rec.record('companyAdminWithCompanyContext', withContext);
    rec.record('companyAdminCoreNodesInCompanyDb', adminNodes);
    expect(['allowed', 'denied']).toContain(withContext);
  });

  it('a /limits profile edit lands in the PLATFORM database only — Company A\'s limit_profiles stays empty', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await controller.setProfile({ user: { id: platformAdminId } } as never, KEY, { maxValue: 1 });
    expect(Number((await platformDs.query(`SELECT count(*)::int AS n FROM "limit_profiles" WHERE "limitKey" = $1`, [KEY]))[0].n)).toBe(1);
    expect(Number((await dsA.query(`SELECT count(*)::int AS n FROM "limit_profiles" WHERE "limitKey" = $1`, [KEY]))[0].n)).toBe(0);
  });

  it('that platform edit does NOT constrain Company A: the Company-side check/consume read Company A\'s own (empty) profiles → unlimited', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const platformSide = await limits.check(KEY, 5);
    const companyASide = await limits.check(KEY, 5, dsA.manager);
    const consumed = await limits.consume(KEY, 5, dsA.manager);
    rec.record('platformSideCheck', platformSide);
    rec.record('companyASideCheck', companyASide);
    rec.record('companyAConsume', consumed);
    expect(platformSide.allowed).toBe(false);
    expect(platformSide.max).toBe(1);
    expect(companyASide).toEqual({ allowed: true, max: null, current: null, remaining: null });
    expect(consumed.allowed).toBe(true);
    expect(consumed.max).toBeNull();
  });

  it('service surface: setProfile/clearProfile have NO manager parameter — no Company-capable limit edit path exists at the service level either', () => {
    expect(LimitService.prototype.setProfile.length).toBe(3); // (limitKey, maxValue, actorUserId)
    expect(LimitService.prototype.clearProfile.length).toBe(2); // (limitKey, actorUserId)
    expect(LimitService.prototype.check.length).toBeGreaterThanOrEqual(1);
  });
});
