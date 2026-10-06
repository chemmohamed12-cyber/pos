import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../authentication/auth.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from './company-context.guard';
import { CompanyRegistryService } from './company-registry.service';
import { CompanyActivationService } from './company-activation.service';
import { COMPANY_NOT_READY_CODE } from './company-operational-status';
import { CompanyDatabaseNotActiveError } from '../database-registry/company-connection-manager.service';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { AuthorizationService } from '../authorization/authorization.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';

/**
 * WP-4.1 — DP-9 Layer 1 enforcement, REAL-POSTGRES + two-Company ISOLATION proof
 * (CTO Executive Order 2026-10-06). Supersedes the WP-0.5 F1 characterization
 * (`company-suspension-access-path.characterization.spec.ts`, which asserted the
 * pre-enforcement behavior and is retired by this package).
 *
 * Real: AuthService, JwtService, JwtAuthGuard, CompanyContextGuard, CompanyService,
 * CompanyRegistryService, CompanyActivationService, MembershipService, UsersService,
 * CompanyConnectionManagerService, two real Company databases.
 * Doubles: only the refresh-token repository (in-memory) and the unused credentials repo.
 *
 * Isolation proof (not just the HTTP response): `getDataSource` is spied; a
 * non-READY Company's DataSource is NEVER requested by the guard, and Company B
 * keeps reaching its own database while Company A is blocked.
 */
describe('WP-4.1 — DP-9 Layer 1 (READY-only operational access), real-Postgres + A/B isolation', () => {
  jest.setTimeout(300_000);
  const ACCESS_SECRET = 'test-access-secret';
  let h: TwoCompanyHarness;
  let auth: AuthService;
  let jwtGuard: JwtAuthGuard;
  let companyGuard: CompanyContextGuard;
  let activation: CompanyActivationService;
  let userAId: string;
  let userBId: string;
  let outsiderId: string;
  let refreshRows: Array<Record<string, unknown>>;
  let getDataSourceSpy: jest.SpyInstance;

  const ctx = (request: unknown) => ({ switchToHttp: () => ({ getRequest: () => request }) }) as never;

  async function requestWith(accessToken: string): Promise<CompanyScopedRequest> {
    const request = { headers: { authorization: `Bearer ${accessToken}` } } as unknown as AuthenticatedRequest;
    await jwtGuard.canActivate(ctx(request));
    await companyGuard.canActivate(ctx(request));
    return request as CompanyScopedRequest;
  }

  const setStatus = (id: string, status: string) => h.controlPlane.query(`UPDATE "companies" SET "status" = $1 WHERE "id" = $2`, [status, id]);
  const companyStatus = async (id: string) => (await h.controlPlane.query(`SELECT "status" FROM "companies" WHERE "id" = $1`, [id]))[0].status as string;
  const registryStatus = async (id: string) => (await h.controlPlane.getRepository(DatabaseRegistry).findOneOrFail({ where: { companyId: id } })).status;
  const dbOf = async (req: CompanyScopedRequest) => (await req.companyContext!.dataSource.query(`SELECT current_database() AS db`))[0].db as string;

  async function expectNotReady(promise: Promise<unknown>): Promise<HttpException> {
    const err = (await promise.then(
      () => {
        throw new Error('expected COMPANY_NOT_READY but the call succeeded');
      },
      (e: unknown) => e,
    )) as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(409);
    expect((err.getResponse() as { code: string }).code).toBe(COMPANY_NOT_READY_CODE);
    return err;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'wp41_layer1', roleModuleCodes: ['sales'] });
    const userA = await h.createUserWithAdminRoleIn('WP41 User A', h.companyAId);
    const userB = await h.createUserWithAdminRoleIn('WP41 User B', h.companyBId);
    const outsider = await h.users.create({ fullName: 'WP41 Outsider', email: 'wp41-outsider@test.local' });
    userAId = userA.id;
    userBId = userB.id;
    outsiderId = outsider.id;
    await h.users.setStatus(userAId, 'active');
    await h.users.setStatus(userBId, 'active');

    refreshRows = [];
    const refreshTokens = {
      create: (d: Record<string, unknown>) => ({ ...d }),
      save: async (row: Record<string, unknown>) => {
        refreshRows.push(row);
        return row;
      },
      findOne: async ({ where }: { where: { tokenHash: string } }) => refreshRows.find((r) => r.tokenHash === where.tokenHash) ?? null,
      update: async () => undefined,
    };
    const jwt = new JwtService({});
    const config = { auth: { accessSecret: ACCESS_SECRET, accessTtlSeconds: 900, refreshTtlDays: 7 } };
    auth = new AuthService({} as never, refreshTokens as never, h.users, jwt, config as never, {} as unknown as AuthorizationService, h.memberships, h.companies);
    jwtGuard = new JwtAuthGuard(jwt, h.users, config as never);
    companyGuard = new CompanyContextGuard(h.memberships, h.companies, h.connections);
    activation = new CompanyActivationService(new CompanyRegistryService(h.companies));
    getDataSourceSpy = jest.spyOn(h.connections, 'getDataSource');
  });

  afterAll(async () => {
    await h.teardown();
  });

  let tokenIssuedWhileReady = { accessToken: '', refreshToken: '' };

  it('READY → allowed: select-company issues a token and the guards give the member Company A\'s real database', async () => {
    tokenIssuedWhileReady = await auth.selectCompany(userAId, h.companyAId);
    const req = await requestWith(tokenIssuedWhileReady.accessToken);
    expect(req.companyContext?.companyId).toBe(h.companyAId);
    expect(await dbOf(req)).toBe(h.companyADbName);
    expect(await companyStatus(h.companyAId)).toBe('READY');
  });

  it('SUSPENDED → blocked: an ALREADY-ISSUED token is rejected on the very next request with 409 COMPANY_NOT_READY, and Company A\'s DataSource is NEVER requested', async () => {
    await activation.suspend(h.companyAId);
    expect(await companyStatus(h.companyAId)).toBe('SUSPENDED');
    expect(await registryStatus(h.companyAId)).toBe('ACTIVE'); // registry untouched — it is NOT the lifecycle authority (D-7)

    getDataSourceSpy.mockClear();
    const err = await expectNotReady(requestWith(tokenIssuedWhileReady.accessToken));
    expect(getDataSourceSpy).not.toHaveBeenCalled(); // no DataSource opened for a non-READY Company

    // The response carries no internal state: no status value, no Company id, no database name.
    expect(err.getResponse()).toEqual({ statusCode: 409, error: 'Conflict', code: COMPANY_NOT_READY_CODE, message: 'This Company is currently unavailable.' });
    const body = JSON.stringify(err.getResponse());
    for (const leak of ['SUSPENDED', h.companyAId, h.companyBId, h.companyADbName, h.companyBDbName, 'ACTIVE']) expect(body).not.toContain(leak);
  });

  it('SUSPENDED → selectCompany is rejected (409 COMPANY_NOT_READY) and NO token is issued', async () => {
    const before = refreshRows.length;
    await expectNotReady(auth.selectCompany(userAId, h.companyAId));
    expect(refreshRows.length).toBe(before); // nothing was minted or persisted
  });

  it('SUSPENDED → refresh does NOT return the Company claim; the session survives without Company context and cannot reach any Company route', async () => {
    const refreshed = await auth.refresh(tokenIssuedWhileReady.refreshToken);
    const payload = new JwtService({}).decode(refreshed.accessToken) as { sub: string; companyId?: string };
    expect(payload.sub).toBe(userAId);
    expect(payload.companyId).toBeUndefined();

    getDataSourceSpy.mockClear();
    await expect(requestWith(refreshed.accessToken)).rejects.toThrow(/requires a Company context/);
    expect(getDataSourceSpy).not.toHaveBeenCalled();
  });

  it('ISOLATION — while A is SUSPENDED, Company B is unaffected and reaches only its own database; A\'s token cannot be used to reach B', async () => {
    expect(await companyStatus(h.companyBId)).toBe('READY');
    const tokenB = await auth.selectCompany(userBId, h.companyBId);
    getDataSourceSpy.mockClear();
    const req = await requestWith(tokenB.accessToken);
    expect(req.companyContext?.companyId).toBe(h.companyBId);
    expect(await dbOf(req)).toBe(h.companyBDbName);
    expect(getDataSourceSpy).toHaveBeenCalledTimes(1);
    expect(getDataSourceSpy).toHaveBeenCalledWith(h.companyBId);
    expect(getDataSourceSpy).not.toHaveBeenCalledWith(h.companyAId);

    // User B holds no Membership in A: even though A is non-READY, B's user is told nothing about A's state.
    await expect(auth.selectCompany(userBId, h.companyAId)).rejects.toThrow(/not a member/);
  });

  it('A non-member learns nothing about a non-READY Company: Membership is checked first (403/401, never 409), and no DataSource is requested', async () => {
    getDataSourceSpy.mockClear();
    await expect(auth.selectCompany(outsiderId, h.companyAId)).rejects.toThrow(/not a member/);
    const req = { user: { id: outsiderId, email: 'x@y.z', companyId: h.companyAId } };
    await expect(companyGuard.canActivate(ctx(req))).rejects.toThrow(/not a member/);
    expect(getDataSourceSpy).not.toHaveBeenCalled();
  });

  it('SUSPENDED → DECOMMISSIONED → blocked as well (selectCompany and an issued-token request), no DataSource opened', async () => {
    await activation.decommission(h.companyAId);
    expect(await companyStatus(h.companyAId)).toBe('DECOMMISSIONED');
    expect(await registryStatus(h.companyAId)).toBe('ACTIVE');
    getDataSourceSpy.mockClear();
    await expectNotReady(auth.selectCompany(userAId, h.companyAId));
    await expectNotReady(requestWith(tokenIssuedWhileReady.accessToken));
    expect(getDataSourceSpy).not.toHaveBeenCalled();
  });

  it('Every non-READY status blocks (DP-9 O-4): PROVISIONING, DEGRADED, MIGRATING, FAILED — and READY is allowed again with no stale window', async () => {
    const tokenB = await auth.selectCompany(userBId, h.companyBId);
    for (const status of ['PROVISIONING', 'DEGRADED', 'MIGRATING', 'FAILED']) {
      await setStatus(h.companyBId, status);
      getDataSourceSpy.mockClear();
      await expectNotReady(requestWith(tokenB.accessToken)); // same JWT, flipped between requests
      await expectNotReady(auth.selectCompany(userBId, h.companyBId));
      expect(getDataSourceSpy).not.toHaveBeenCalled();
    }
    await setStatus(h.companyBId, 'READY');
    expect((await requestWith(tokenB.accessToken)).companyContext?.companyId).toBe(h.companyBId); // no cache of the blocked state
  });

  it('REACTIVATION — suspend() then reactivate(): the Company is operational again for the same issued token', async () => {
    const tokenB = await auth.selectCompany(userBId, h.companyBId);
    await activation.suspend(h.companyBId);
    await expectNotReady(requestWith(tokenB.accessToken));
    await activation.reactivate(h.companyBId);
    expect(await companyStatus(h.companyBId)).toBe('READY');
    expect(await dbOf(await requestWith(tokenB.accessToken))).toBe(h.companyBDbName);
  });

  it('V-09a — registry marked non-ACTIVE while Company.status is READY: refused as infrastructure protection (NOT a 409 lifecycle decision); Company.status is never derived from the registry', async () => {
    const tokenB = await auth.selectCompany(userBId, h.companyBId);
    await h.controlPlane.getRepository(DatabaseRegistry).update({ companyId: h.companyBId }, { status: 'FAILED' });
    await expect(requestWith(tokenB.accessToken)).rejects.toThrow(CompanyDatabaseNotActiveError);
    expect(await companyStatus(h.companyBId)).toBe('READY'); // lifecycle untouched by registry health
    await h.controlPlane.getRepository(DatabaseRegistry).update({ companyId: h.companyBId }, { status: 'ACTIVE' });
  });
});
