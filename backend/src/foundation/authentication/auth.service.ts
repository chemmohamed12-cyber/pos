import { createHash, randomUUID, randomBytes } from 'crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { Credential } from './credential.entity';
import { RefreshToken } from './refresh-token.entity';
import { UsersService } from '../identity/users.service';
import { AppConfigService } from '../configuration/app-config.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { User } from '../identity/user.entity';
import { JWT_SIGN_OPTIONS } from './jwt-constants';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Authentication — Stage 2 build-order item 6.
 * Daii/architecture/DAII_SECURITY_ARCHITECTURE.md §2, ADR-004.
 *
 * The ONE centralized Authentication Foundation — no domain and no other
 * actor type (mobile, driver, etc.) reimplements this (directly reverses
 * the 4x-duplicated-auth-engine anti-pattern found in xnexus-website,
 * Daii/_source-audits/xnexus-website/).
 *
 * Scope note: role/permission resolution is Authorization's job
 * (build-order item 7, not built yet) — this service only answers
 * "is this actor who they claim to be, and is their account usable."
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(Credential) private readonly credentials: Repository<Credential>,
    @InjectRepository(RefreshToken) private readonly refreshTokens: Repository<RefreshToken>,
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly authorization: AuthorizationService,
  ) {}

  /**
   * Bootstrap registration: auto-activates the account (no
   * email-verification step) and auto-grants 'admin' to the very first
   * user ever created (a common, deliberate bootstrap convenience so an
   * empty system has someone able to administer it). Still no
   * email-verification step for users #2+, but `AuthController.register`
   * now requires the caller to already be an authenticated admin once
   * the first user exists (V1 Release Audit BLOCKER fix — this method
   * itself has no gate, so any other caller must enforce one).
   */
  async register(email: string, fullName: string, password: string): Promise<User> {
    const isFirstUser = (await this.users.count()) === 0;
    const user = await this.users.create({ email, fullName });
    await this.users.setStatus(user.id, 'active');
    await this.setPassword(user.id, password);
    if (isFirstUser) {
      await this.authorization.assignRole(user.id, 'admin');
    }
    return this.users.findById(user.id);
  }

  /** Attaches a password to an already-created (Identity) user. Not a public self-registration endpoint. */
  async setPassword(userId: string, plainPassword: string): Promise<void> {
    const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
    const existing = await this.credentials.findOne({ where: { userId } });
    const record = existing ?? this.credentials.create({ userId });
    record.passwordHash = passwordHash;
    record.passwordChangedAt = new Date();
    record.failedLoginAttempts = 0;
    record.lockedUntil = null;
    await this.credentials.save(record);
    // Password change invalidates every existing session (DAII_SECURITY_ARCHITECTURE.md §2).
    await this.refreshTokens.update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  /**
   * Commercial Release Gate finding SEC-08 (red-team RT12 — "unknown path
   * challenge"). `setPassword` alone is an ADMIN/bootstrap primitive: it
   * asks for no proof of the current password. Wiring it straight to a
   * user-facing `POST /auth/change-password` meant a STOLEN ACCESS TOKEN
   * (XSS, an unattended session, a token in a log) was enough to set a new
   * password and take the account over permanently — the victim's own
   * password stops working, the attacker just logs in from then on.
   * Re-authentication is the standard control for exactly that containment
   * (OWASP ASVS 2.1 credential-change requirements); this method is the
   * user-facing path and `setPassword` stays the admin/bootstrap one.
   */
  async changeOwnPassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const credential = await this.credentials.findOne({ where: { userId } });
    // Generic message either way — never reveal whether the account merely
    // has no credential row vs. supplied the wrong current password.
    if (!credential || !(await bcrypt.compare(currentPassword, credential.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect.');
    }
    await this.setPassword(userId, newPassword);
  }

  async login(email: string, plainPassword: string): Promise<TokenPair> {
    const user = await this.users.findByEmail(email);
    if (!user) {
      // Security Assurance Gate — Track S14: previously silent. The client
      // response stays the same generic "Invalid email or password" (never
      // confirm which half is wrong) — this is a server-side-only log, a
      // different trust boundary, and the standard place to record the
      // attempted identifier for brute-force/credential-stuffing detection.
      this.logger.warn(`Login failed (no account for this email): ${email}`);
      throw new UnauthorizedException('Invalid email or password.');
    }
    // Fail closed on a positive disabled/suspended/pending signal — never fail open here
    // (DAII_SECURITY_ARCHITECTURE.md §2, adopted from baseline's requireAuth discipline).
    if (user.status !== 'active') {
      this.logger.warn(`Login blocked (account not active, status=${user.status}): ${email}`);
      throw new UnauthorizedException('Account is not active.');
    }
    const credential = await this.credentials.findOne({ where: { userId: user.id } });
    if (!credential) {
      this.logger.warn(`Login failed (no credential record for user): ${email}`);
      throw new UnauthorizedException('Invalid email or password.');
    }
    // Checked before the password compare, deliberately — a locked account
    // shouldn't pay (or leak timing from) a bcrypt cycle it's not allowed
    // to complete anyway.
    if (credential.lockedUntil && credential.lockedUntil > new Date()) {
      this.logger.warn(`Login blocked (account locked until ${credential.lockedUntil.toISOString()}): ${email}`);
      throw new UnauthorizedException('Account temporarily locked due to repeated failed login attempts. Try again later.');
    }
    const valid = await bcrypt.compare(plainPassword, credential.passwordHash);
    if (!valid) {
      credential.failedLoginAttempts += 1;
      if (credential.failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        credential.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
        this.logger.warn(`Account locked after ${credential.failedLoginAttempts} failed login attempts: ${email}`);
      } else {
        this.logger.warn(`Login failed (bad password, attempt ${credential.failedLoginAttempts}/${MAX_FAILED_LOGIN_ATTEMPTS}): ${email}`);
      }
      await this.credentials.save(credential);
      throw new UnauthorizedException('Invalid email or password.');
    }
    if (credential.failedLoginAttempts > 0 || credential.lockedUntil) {
      credential.failedLoginAttempts = 0;
      credential.lockedUntil = null;
      await this.credentials.save(credential);
    }
    return this.issueTokenPair(user.id, randomUUID());
  }

  /**
   * Rotates a refresh token. Reuse of an already-rotated-out token
   * revokes the whole family — breach detection per
   * DAII_SECURITY_ARCHITECTURE.md §2.
   */
  async refresh(rawRefreshToken: string): Promise<TokenPair> {
    const tokenHash = hashToken(rawRefreshToken);
    const record = await this.refreshTokens.findOne({ where: { tokenHash } });
    if (!record) {
      this.logger.warn('Refresh rejected: token hash not found (unknown or fabricated token).');
      throw new UnauthorizedException('Invalid refresh token.');
    }
    if (record.revokedAt || record.expiresAt < new Date()) {
      // Token was already rotated out (or expired) and is being replayed — revoke the whole family.
      // Security Assurance Gate — Track S14: an already-revoked token being
      // replayed is a genuine session-hijack signal (someone captured a
      // refresh token that was already rotated out by its legitimate
      // owner's own next request) — logged at `error`, the highest-value
      // single security event in this codebase to have previously been
      // completely silent. A naturally expired token being reused is far
      // more likely ordinary user inactivity, not an attack — logged only
      // at `warn`, distinguished here so this doesn't flood an operator
      // with false hijack alarms; the RESPONSE to the caller is unchanged
      // either way (out of scope for a logging-only fix).
      if (record.revokedAt) {
        this.logger.error(`Refresh token reuse detected — an already-rotated-out token was replayed. Session family revoked. userId=${record.userId} family=${record.family}`);
      } else {
        this.logger.warn(`Refresh rejected: token expired. Session family revoked as a precaution. userId=${record.userId} family=${record.family}`);
      }
      await this.refreshTokens.update({ family: record.family }, { revokedAt: new Date() });
      throw new UnauthorizedException('Refresh token reuse detected; session revoked.');
    }
    await this.refreshTokens.update({ id: record.id }, { revokedAt: new Date() });
    return this.issueTokenPair(record.userId, record.family);
  }

  async logout(rawRefreshToken: string): Promise<void> {
    const tokenHash = hashToken(rawRefreshToken);
    const record = await this.refreshTokens.findOne({ where: { tokenHash } });
    if (!record) return;
    await this.refreshTokens.update({ family: record.family }, { revokedAt: new Date() });
  }

  private async issueTokenPair(userId: string, family: string): Promise<TokenPair> {
    const { accessSecret, accessTtlSeconds, refreshTtlDays } = this.config.auth;
    const accessToken = await this.jwt.signAsync(
      { sub: userId },
      { secret: accessSecret, expiresIn: accessTtlSeconds, ...JWT_SIGN_OPTIONS },
    );

    const rawRefreshToken = randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + refreshTtlDays * 24 * 60 * 60 * 1000);
    const entity = this.refreshTokens.create({
      userId,
      family,
      tokenHash: hashToken(rawRefreshToken),
      revokedAt: null,
      expiresAt,
    });
    await this.refreshTokens.save(entity);

    return { accessToken, refreshToken: rawRefreshToken };
  }
}
