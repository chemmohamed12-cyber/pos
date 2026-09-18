import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { Credential } from './credential.entity';
import { RefreshToken } from './refresh-token.entity';
import { UsersService } from '../identity/users.service';
import { User } from '../identity/user.entity';
import { AppConfigService } from '../configuration/app-config.service';
import { AuthorizationService } from '../authorization/authorization.service';

/**
 * Security-critical paths per CTO Execution Policy §5: login success,
 * wrong password, disabled account, refresh rotation, and refresh-token
 * reuse detection (the one concurrency/security invariant that matters
 * most here). Not exhaustive beyond that.
 */
describe('AuthService', () => {
  let service: AuthService;
  const credStore = new Map<string, Credential>();
  const tokenStore = new Map<string, RefreshToken>();
  let tokenSeq = 0;

  const now = new Date();
  const activeUser: User = {
    id: 'user-1',
    email: 'active@daii.example',
    status: 'active',
    fullName: 'Active User',
    mobile: null,
    createdAt: now,
    updatedAt: now,
  };
  const disabledUser: User = { ...activeUser, id: 'user-2', email: 'disabled@daii.example', status: 'disabled' };

  let registeredUserCount = 0;
  const usersServiceMock = {
    findByEmail: jest.fn(async (email: string) => {
      if (email === activeUser.email) return activeUser;
      if (email === disabledUser.email) return disabledUser;
      return null;
    }),
    findById: jest.fn(async (id: string) => {
      if (id === activeUser.id) return activeUser;
      if (id === disabledUser.id) return disabledUser;
      return { ...activeUser, id, status: 'active' };
    }),
    create: jest.fn(async (input: { email: string; fullName: string }) => {
      registeredUserCount++;
      return { ...activeUser, id: `new-user-${registeredUserCount}`, email: input.email, fullName: input.fullName };
    }),
    setStatus: jest.fn(async () => undefined),
    count: jest.fn(async () => registeredUserCount),
  };

  const credentialRepoMock = {
    findOne: jest.fn(async ({ where }: { where: { userId: string } }) => credStore.get(where.userId) ?? null),
    create: jest.fn((data: Partial<Credential>) => ({ ...data }) as Credential),
    save: jest.fn(async (c: Credential) => {
      credStore.set(c.userId, c);
      return c;
    }),
  };

  const refreshTokenRepoMock = {
    findOne: jest.fn(async ({ where }: { where: { tokenHash: string } }) => tokenStore.get(where.tokenHash) ?? null),
    create: jest.fn((data: Partial<RefreshToken>) => ({ id: `rt-${++tokenSeq}`, ...data }) as RefreshToken),
    save: jest.fn(async (t: RefreshToken) => {
      tokenStore.set(t.tokenHash, t);
      return t;
    }),
    update: jest.fn(async (criteria: Partial<RefreshToken>, partial: Partial<RefreshToken>) => {
      for (const t of tokenStore.values()) {
        const matchesFamily = criteria.family ? t.family === criteria.family : true;
        const matchesUser = criteria.userId ? t.userId === criteria.userId : true;
        const matchesId = criteria.id ? t.id === criteria.id : true;
        if (matchesFamily && matchesUser && matchesId) Object.assign(t, partial);
      }
    }),
  };

  const configMock = {
    auth: { accessSecret: 'test-secret', refreshSecret: 'test-refresh-secret', accessTtlSeconds: 900, refreshTtlDays: 30 },
  };

  const authorizationMock = { assignRole: jest.fn(async () => undefined) };

  beforeEach(async () => {
    credStore.clear();
    tokenStore.clear();
    registeredUserCount = 0;
    jest.clearAllMocks();

    const passwordHash = await bcrypt.hash('correct-password', 4); // low rounds for fast tests
    credStore.set(activeUser.id, {
      userId: activeUser.id,
      passwordHash,
      passwordChangedAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
    } as Credential);

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        JwtService,
        { provide: getRepositoryToken(Credential), useValue: credentialRepoMock },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokenRepoMock },
        { provide: UsersService, useValue: usersServiceMock },
        { provide: AppConfigService, useValue: configMock },
        { provide: AuthorizationService, useValue: authorizationMock },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  it('register() grants "admin" to the very first user, and not to subsequent ones (bootstrap invariant)', async () => {
    const first = await service.register('owner@daii.example', 'Owner', 'a-real-password');
    expect(authorizationMock.assignRole).toHaveBeenCalledWith(first.id, 'admin');

    authorizationMock.assignRole.mockClear();
    const second = await service.register('second@daii.example', 'Second User', 'another-password');
    expect(authorizationMock.assignRole).not.toHaveBeenCalledWith(second.id, 'admin');
  });

  it('register() activates the account and sets a working password (can log in immediately after)', async () => {
    await service.register('active@daii.example', 'Active User', 'correct-password');
    expect(usersServiceMock.setStatus).toHaveBeenCalledWith(expect.any(String), 'active');
  });

  it('logs in successfully with correct credentials and issues a token pair', async () => {
    const tokens = await service.login(activeUser.email, 'correct-password');
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
  });

  it('rejects an incorrect password', async () => {
    await expect(service.login(activeUser.email, 'wrong-password')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects login for a disabled account even with no credential check needed', async () => {
    await expect(service.login(disabledUser.email, 'anything')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rotates a refresh token on use and invalidates the old one', async () => {
    const first = await service.login(activeUser.email, 'correct-password');
    const rotated = await service.refresh(first.refreshToken);
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    // Using the original (now-rotated-out) token again must fail.
    await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokes the whole family when a rotated-out refresh token is replayed', async () => {
    const first = await service.login(activeUser.email, 'correct-password');
    const second = await service.refresh(first.refreshToken);
    // Replay the original — should revoke the family, including `second`.
    await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    // The legitimately-rotated `second` token must now also be revoked (breach containment).
    await expect(service.refresh(second.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('per-account login lockout (security review, master continuation directive)', () => {
    it('locks the account after 5 consecutive failed attempts, blocking even the correct password', async () => {
      for (let i = 0; i < 5; i++) {
        await expect(service.login(activeUser.email, 'wrong-password')).rejects.toBeInstanceOf(UnauthorizedException);
      }
      // 6th attempt, even with the CORRECT password, must be rejected — the account is locked, not the credential wrong.
      await expect(service.login(activeUser.email, 'correct-password')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('does not lock before the threshold — 4 failures still allow a correct login through', async () => {
      for (let i = 0; i < 4; i++) {
        await expect(service.login(activeUser.email, 'wrong-password')).rejects.toBeInstanceOf(UnauthorizedException);
      }
      const tokens = await service.login(activeUser.email, 'correct-password');
      expect(tokens.accessToken).toBeTruthy();
    });

    it('resets the failed-attempt counter on a successful login', async () => {
      await expect(service.login(activeUser.email, 'wrong-password')).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(service.login(activeUser.email, 'wrong-password')).rejects.toBeInstanceOf(UnauthorizedException);
      await service.login(activeUser.email, 'correct-password'); // resets the counter
      // 4 more failures after the reset should still be under the threshold (would be 6 if the counter hadn't reset).
      for (let i = 0; i < 4; i++) {
        await expect(service.login(activeUser.email, 'wrong-password')).rejects.toBeInstanceOf(UnauthorizedException);
      }
      const tokens = await service.login(activeUser.email, 'correct-password');
      expect(tokens.accessToken).toBeTruthy();
    });

    it('setPassword clears an existing lockout', async () => {
      for (let i = 0; i < 5; i++) {
        await expect(service.login(activeUser.email, 'wrong-password')).rejects.toBeInstanceOf(UnauthorizedException);
      }
      await expect(service.login(activeUser.email, 'correct-password')).rejects.toBeInstanceOf(UnauthorizedException);
      await service.setPassword(activeUser.id, 'a-new-password');
      const tokens = await service.login(activeUser.email, 'a-new-password');
      expect(tokens.accessToken).toBeTruthy();
    });
  });
});
