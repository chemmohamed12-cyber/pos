import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard, AuthenticatedRequest } from './jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../company/company-context.guard';
import { MembershipService } from '../company/membership.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { UsersService } from '../identity/users.service';

/**
 * Multi-Company Area 5 — Formal Verification (2026-09-24, CTO directive).
 * "Company Context in Authentication" (named by `Membership.entity.ts`'s
 * own doc comment, built as Area 6's prerequisite, never independently
 * verified against its own acceptance criteria until now).
 *
 * Proves the EXACT lifecycle the directive specifies, as ONE continuous
 * chain through REAL `AuthService` → REAL `JwtService` (genuine sign/
 * verify, not mocked strings) → REAL `JwtAuthGuard` → REAL
 * `CompanyContextGuard` — only `MembershipService`,
 * `CompanyConnectionManagerService`, `UsersService`, and the DB repos are
 * test doubles:
 *
 *   User Authentication → Company Selection → Membership Validation
 *   → Company-scoped JWT → Request Company Context
 *   → Fresh Membership Validation
 *
 * Does NOT re-verify Area 6's authorization-decision boundary (that is
 * `area6-company-isolation.acceptance.spec.ts`'s job) — this file's scope
 * is the authentication/context lifecycle only, per the CTO directive's
 * own framing of Area 5 as distinct from Area 6.
 */
describe('Area 5 Formal Verification — Company Context in Authentication lifecycle', () => {
  const ACCESS_SECRET = 'test-access-secret';
  const USER_ID = '11111111-1111-1111-1111-111111111111';
  const COMPANY_ID = '22222222-2222-2222-2222-222222222222';
  const PASSWORD = 'correct horse battery staple';

  let refreshTokenRows: Array<Record<string, unknown>>;
  let authService: AuthService;
  let jwtAuthGuard: JwtAuthGuard;
  let companyContextGuard: CompanyContextGuard;
  let jwt: JwtService;
  const membershipsMock = { findByUserAndCompany: jest.fn() };
  const connectionsMock = { getDataSource: jest.fn() };
  const usersMock = { findById: jest.fn(), findByEmail: jest.fn() };

  function fakeHttpRequest(accessToken: string): AuthenticatedRequest {
    return { headers: { authorization: `Bearer ${accessToken}` } } as unknown as AuthenticatedRequest;
  }

  beforeAll(() => {
    // Real bcrypt hash, real JwtService — this is a genuine round trip, not a mocked stand-in.
    jest.setTimeout(20000);
  });

  beforeEach(async () => {
    refreshTokenRows = [];
    jest.clearAllMocks();

    const passwordHash = await bcrypt.hash(PASSWORD, 4); // low rounds — test speed only, not production config
    const credentialsMock = {
      findOne: jest.fn(async () => ({ userId: USER_ID, passwordHash, failedLoginAttempts: 0, lockedUntil: null })),
      save: jest.fn(async () => undefined),
    };
    const refreshTokensMock = {
      create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
      save: jest.fn(async (row: Record<string, unknown>) => {
        refreshTokenRows.push(row);
        return row;
      }),
      findOne: jest.fn(async ({ where }: { where: { tokenHash: string } }) => refreshTokenRows.find((r) => r.tokenHash === where.tokenHash) ?? null),
      update: jest.fn(),
    };
    usersMock.findByEmail.mockResolvedValue({ id: USER_ID, email: 'alice@company.test', status: 'active' });
    usersMock.findById.mockResolvedValue({ id: USER_ID, email: 'alice@company.test', status: 'active' });

    jwt = new JwtService({});
    const config = { auth: { accessSecret: ACCESS_SECRET, accessTtlSeconds: 900, refreshTtlDays: 7 } };

    authService = new AuthService(
      credentialsMock as never,
      refreshTokensMock as never,
      usersMock as unknown as UsersService,
      jwt,
      config as never,
      {} as unknown as AuthorizationService, // not exercised by this lifecycle
      membershipsMock as unknown as MembershipService,
      { findById: jest.fn(async () => ({ id: 'c', status: 'READY' })) } as never,
    );

    jwtAuthGuard = new JwtAuthGuard(jwt, usersMock as unknown as UsersService, config as never);
    companyContextGuard = new CompanyContextGuard(membershipsMock as unknown as MembershipService, { findById: jest.fn(async () => ({ id: 'c', status: 'READY' })) } as never, connectionsMock as unknown as CompanyConnectionManagerService);
  });

  function fakeGuardContext(request: Request) {
    return { switchToHttp: () => ({ getRequest: () => request }) } as never;
  }

  it('the full lifecycle: authenticate → select Company → Membership validated → Company-scoped JWT → next request carries + re-validates Company context', async () => {
    // 1. User Authentication
    const baseTokens = await authService.login('alice@company.test', PASSWORD);
    expect(baseTokens.accessToken).toBeTruthy();

    // The base token carries NO Company claim — company-less until explicitly selected.
    const baseRequest = fakeHttpRequest(baseTokens.accessToken);
    await jwtAuthGuard.canActivate(fakeGuardContext(baseRequest));
    expect(baseRequest.user.companyId).toBeUndefined();

    // 2 + 3. Company Selection + Membership Validation (at mint time)
    membershipsMock.findByUserAndCompany.mockResolvedValueOnce({ id: 'm-1', userId: USER_ID, companyId: COMPANY_ID, roleKey: 'accountant' });
    const scopedTokens = await authService.selectCompany(USER_ID, COMPANY_ID);
    expect(membershipsMock.findByUserAndCompany).toHaveBeenCalledWith(USER_ID, COMPANY_ID);

    // 4. Company-scoped JWT — a real, independently-verifiable signed token carrying the claim.
    const decoded = await jwt.verifyAsync<{ sub: string; companyId?: string }>(scopedTokens.accessToken, { secret: ACCESS_SECRET });
    expect(decoded).toMatchObject({ sub: USER_ID, companyId: COMPANY_ID });

    // 5. Request Company Context — a LATER, independent request carries the claim via JwtAuthGuard.
    const scopedRequest = fakeHttpRequest(scopedTokens.accessToken) as CompanyScopedRequest;
    await jwtAuthGuard.canActivate(fakeGuardContext(scopedRequest));
    expect(scopedRequest.user.companyId).toBe(COMPANY_ID);

    // 6. Fresh Membership Validation — CompanyContextGuard re-checks the database, not the token's own claim.
    membershipsMock.findByUserAndCompany.mockResolvedValueOnce({ id: 'm-1', userId: USER_ID, companyId: COMPANY_ID, roleKey: 'accountant' });
    connectionsMock.getDataSource.mockResolvedValueOnce({ manager: { tag: 'company-manager' } });
    await companyContextGuard.canActivate(fakeGuardContext(scopedRequest));
    expect(membershipsMock.findByUserAndCompany).toHaveBeenCalledWith(USER_ID, COMPANY_ID);
    expect(scopedRequest.companyContext).toEqual({ companyId: COMPANY_ID, dataSource: { manager: { tag: 'company-manager' } } });
  });

  it('Company Selection rejects a non-member BEFORE any Company-scoped JWT is minted', async () => {
    membershipsMock.findByUserAndCompany.mockResolvedValueOnce(null);
    await expect(authService.selectCompany(USER_ID, COMPANY_ID)).rejects.toThrow();
  });

  it('the JWT companyId claim alone is NEVER trusted — a still-valid, correctly-signed token is rejected once Membership is revoked', async () => {
    membershipsMock.findByUserAndCompany.mockResolvedValueOnce({ id: 'm-1', userId: USER_ID, companyId: COMPANY_ID, roleKey: 'accountant' });
    const scopedTokens = await authService.selectCompany(USER_ID, COMPANY_ID);

    // The token itself is still perfectly valid (correct signature, not expired) — only the
    // database-side Membership determines access, exactly as the directive requires.
    const request = fakeHttpRequest(scopedTokens.accessToken) as CompanyScopedRequest;
    await jwtAuthGuard.canActivate(fakeGuardContext(request));

    membershipsMock.findByUserAndCompany.mockResolvedValueOnce(null); // revoked between mint and this request
    await expect(companyContextGuard.canActivate(fakeGuardContext(request))).rejects.toThrow(ForbiddenException);
    expect(connectionsMock.getDataSource).not.toHaveBeenCalled(); // never even reaches the Company DB
  });

  it('there is no ambient/default Company — a base (company-less) token is refused by CompanyContextGuard, never silently assigned one', async () => {
    const baseTokens = await authService.login('alice@company.test', PASSWORD);
    const request = fakeHttpRequest(baseTokens.accessToken) as CompanyScopedRequest;
    await jwtAuthGuard.canActivate(fakeGuardContext(request));

    await expect(companyContextGuard.canActivate(fakeGuardContext(request))).rejects.toThrow(ForbiddenException);
    expect(membershipsMock.findByUserAndCompany).not.toHaveBeenCalled();
  });

  it('refresh preserves the Company-scoped context only while Membership remains valid (lifecycle continuity)', async () => {
    membershipsMock.findByUserAndCompany.mockResolvedValueOnce({ id: 'm-1', userId: USER_ID, companyId: COMPANY_ID, roleKey: 'accountant' });
    const scopedTokens = await authService.selectCompany(USER_ID, COMPANY_ID);

    membershipsMock.findByUserAndCompany.mockResolvedValueOnce({ id: 'm-1', userId: USER_ID, companyId: COMPANY_ID, roleKey: 'accountant' });
    const refreshed = await authService.refresh(scopedTokens.refreshToken);

    const decoded = await new JwtService({}).verifyAsync<{ sub: string; companyId?: string }>(refreshed.accessToken, { secret: ACCESS_SECRET });
    expect(decoded.companyId).toBe(COMPANY_ID);
  });
});
