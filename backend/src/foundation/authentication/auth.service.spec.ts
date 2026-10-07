import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

describe('AuthService — Multi-Company Area 5 (2026-09-23, locked decision): selectCompany + Company claim on refresh', () => {
  let service: AuthService;
  let refreshTokenRows: Array<Record<string, unknown>>;

  const credentialsMock = { findOne: jest.fn(), save: jest.fn(), create: jest.fn() };
  const refreshTokensMock = {
    create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
    save: jest.fn(async (row: Record<string, unknown>) => {
      refreshTokenRows.push(row);
      return row;
    }),
    findOne: jest.fn(async ({ where }: { where: { tokenHash: string } }) => refreshTokenRows.find((r) => r.tokenHash === where.tokenHash) ?? null),
    update: jest.fn(),
  };
  const usersMock = { findById: jest.fn(), findByEmail: jest.fn(), count: jest.fn() };
  const jwtMock = { signAsync: jest.fn(async (payload: Record<string, unknown>) => `signed:${JSON.stringify(payload)}`) };
  const configMock = { auth: { accessSecret: 's', accessTtlSeconds: 900, refreshTtlDays: 7 } };
  const authorizationMock = { assignRole: jest.fn() };
  const membershipsMock = { findActiveByUserAndCompany: jest.fn(), touchLastAccess: jest.fn().mockResolvedValue(undefined) };
  const companiesMock = { findById: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    refreshTokenRows = [];
    companiesMock.findById.mockResolvedValue({ id: 'company-A', status: 'READY' });
    service = new AuthService(
      credentialsMock as never,
      refreshTokensMock as never,
      usersMock as never,
      jwtMock as never,
      configMock as never,
      authorizationMock as never,
      membershipsMock as never,
      companiesMock as never,
    );
  });

  describe('selectCompany', () => {
    it('rejects when the user is not a member of the requested Company — never issues a token', async () => {
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue(null);
      await expect(service.selectCompany('user-1', 'company-B')).rejects.toThrow(UnauthorizedException);
      expect(jwtMock.signAsync).not.toHaveBeenCalled();
    });

    it('issues a Company-scoped token pair when Membership is valid, embedding companyId as a JWT claim', async () => {
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-A', roleKey: 'accountant' });

      const tokens = await service.selectCompany('user-1', 'company-A');

      expect(tokens.accessToken).toContain('"companyId":"company-A"');
      expect(refreshTokenRows[0]).toMatchObject({ userId: 'user-1', companyId: 'company-A' });
    });

    it.each(['PROVISIONING', 'DEGRADED', 'SUSPENDED', 'MIGRATING', 'FAILED', 'DECOMMISSIONED'])('WP-4.1 (DP-9 D-4): a member selecting a %s Company is rejected with 409 COMPANY_NOT_READY — no token is signed or persisted', async (status) => {
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-A', roleKey: 'accountant' });
      companiesMock.findById.mockResolvedValue({ id: 'company-A', status });

      const err = await service.selectCompany('user-1', 'company-A').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ statusCode: 409, code: 'COMPANY_NOT_READY' });
      expect(jwtMock.signAsync).not.toHaveBeenCalled();
      expect(refreshTokenRows).toHaveLength(0);
    });

    it('WP-4.1: a non-member of a non-READY Company gets the Membership rejection (membership first — no state leak)', async () => {
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue(null);
      companiesMock.findById.mockResolvedValue({ id: 'company-A', status: 'SUSPENDED' });
      await expect(service.selectCompany('user-1', 'company-A')).rejects.toThrow(UnauthorizedException);
      expect(companiesMock.findById).not.toHaveBeenCalled();
    });

    it('WP-4.1: a Membership whose Company row is missing is rejected like a missing Membership and issues no token', async () => {
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-A', roleKey: 'accountant' });
      companiesMock.findById.mockResolvedValue(null);
      await expect(service.selectCompany('user-1', 'company-A')).rejects.toThrow(UnauthorizedException);
      expect(jwtMock.signAsync).not.toHaveBeenCalled();
    });
  });

  describe('refresh — Company claim propagation', () => {
    it('preserves the companyId claim across rotation when the Membership is still valid', async () => {
      refreshTokenRows.push({
        id: 'rt-1',
        userId: 'user-1',
        family: 'family-1',
        companyId: 'company-A',
        tokenHash: hashToken('raw-token'),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 100_000),
      });
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-A', roleKey: 'accountant' });

      const tokens = await service.refresh('raw-token');

      expect(tokens.accessToken).toContain('"companyId":"company-A"');
    });

    it('drops the companyId claim on refresh if the Membership was revoked in the meantime — never re-issues a stale grant', async () => {
      refreshTokenRows.push({
        id: 'rt-1',
        userId: 'user-1',
        family: 'family-1',
        companyId: 'company-A',
        tokenHash: hashToken('raw-token'),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 100_000),
      });
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue(null); // revoked

      const tokens = await service.refresh('raw-token');

      expect(tokens.accessToken).not.toContain('companyId');
    });

    it('a refresh token with no Company claim at all stays company-less (unaffected default behavior)', async () => {
      refreshTokenRows.push({
        id: 'rt-1',
        userId: 'user-1',
        family: 'family-1',
        companyId: null,
        tokenHash: hashToken('raw-token'),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 100_000),
      });

      const tokens = await service.refresh('raw-token');

      expect(tokens.accessToken).not.toContain('companyId');
      expect(membershipsMock.findActiveByUserAndCompany).not.toHaveBeenCalled();
    });

    it.each(['SUSPENDED', 'DECOMMISSIONED', 'DEGRADED', 'MIGRATING', 'FAILED', 'PROVISIONING'])('WP-4.1 (DP-9 D-6): refresh drops the companyId claim when the Company is %s — the refresh itself succeeds and the family is NOT revoked', async (status) => {
      refreshTokenRows.push({ id: 'rt-1', userId: 'user-1', family: 'family-1', companyId: 'company-A', tokenHash: hashToken('raw-token'), revokedAt: null, expiresAt: new Date(Date.now() + 100_000) });
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-A', roleKey: 'accountant' });
      companiesMock.findById.mockResolvedValue({ id: 'company-A', status });

      const tokens = await service.refresh('raw-token');

      expect(tokens.accessToken).not.toContain('companyId');
      expect(refreshTokensMock.update).not.toHaveBeenCalledWith({ family: 'family-1' }, expect.anything()); // no family revocation
      expect(refreshTokenRows[refreshTokenRows.length - 1]).toMatchObject({ userId: 'user-1', family: 'family-1', companyId: null });
    });

    it('WP-4.1: refresh drops the claim when the Company row no longer exists', async () => {
      refreshTokenRows.push({ id: 'rt-1', userId: 'user-1', family: 'family-1', companyId: 'company-A', tokenHash: hashToken('raw-token'), revokedAt: null, expiresAt: new Date(Date.now() + 100_000) });
      membershipsMock.findActiveByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-A', roleKey: 'accountant' });
      companiesMock.findById.mockResolvedValue(null);
      expect((await service.refresh('raw-token')).accessToken).not.toContain('companyId');
    });

    it('WP-4.1: a company-less refresh token never reads Company status', async () => {
      refreshTokenRows.push({ id: 'rt-1', userId: 'user-1', family: 'family-1', companyId: null, tokenHash: hashToken('raw-token'), revokedAt: null, expiresAt: new Date(Date.now() + 100_000) });
      await service.refresh('raw-token');
      expect(companiesMock.findById).not.toHaveBeenCalled();
    });
  });
});
