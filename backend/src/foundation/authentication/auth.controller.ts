import { Body, Controller, ForbiddenException, Get, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, IsUUID, MinLength } from 'class-validator';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard, AuthenticatedRequest } from './jwt-auth.guard';
import { UsersService } from '../identity/users.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { AppConfigService } from '../configuration/app-config.service';
import { JWT_VERIFY_OPTIONS } from './jwt-constants';
import { AuthMeService } from './auth-me.service';
import { getLiveConfigEngine } from '../configuration-engine/live-config-accessor';

/**
 * Security Assurance Gate — AUDIT-SEC-26 fix (2026-09-08). Previously a
 * bare `limit: 10` — a literal, compile-time-fixed number with NO
 * connection to the `core.security.rate_limit.auth_per_minute` config key,
 * despite that key being declared `securitySensitive: true`, platform-locked,
 * bounded `3..60`, and governance-reviewed (A-P2-1) as if it genuinely
 * controlled this. An operator tightening it during an active
 * credential-stuffing incident would previously see zero actual effect.
 *
 * `@nestjs/throttler`'s `limit`/`ttl` accept a `Resolvable<number>` — a
 * plain value OR a `(context) => number` function evaluated on EVERY
 * request (`throttler.guard.js`'s own `resolveValue`) — the library's own,
 * officially-typed mechanism for exactly this. Reads the LIVE
 * `ConfigurationEngineService` (admin-editable, hot-reloading — see
 * `live-config-accessor.ts` for why a plain function needs that indirection
 * to reach a DI-managed service) on every call, so a config change takes
 * effect on the very next request — no restart needed. Falls back to `10`
 * (the config key's own declared default) only if the engine hasn't
 * finished bootstrapping yet, or if the value it holds is somehow not a
 * finite number — fails to the SAME safe default either way, never to
 * "unlimited."
 */
export function resolveAuthRateLimit(): number {
  const engine = getLiveConfigEngine();
  if (!engine) return 10;
  try {
    const n = engine.get<number>('core.security.rate_limit.auth_per_minute');
    return typeof n === 'number' && Number.isFinite(n) ? n : 10;
  } catch {
    return 10;
  }
}

class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  fullName!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

class RefreshDto {
  @IsString()
  refreshToken!: string;
}

class SelectCompanyDto {
  @IsUUID()
  companyId!: string;
}

class ChangePasswordDto {
  /**
   * Commercial Release Gate SEC-08: re-authentication is REQUIRED. Without
   * it a stolen access token was enough to take an account over permanently.
   */
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly authorization: AuthorizationService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly authMe: AuthMeService,
  ) {}

  /** The frontend's one source of truth for "who is logged in, with which roles" — drives role-based navigation and permission-aware actions. */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@Req() req: AuthenticatedRequest) {
    if (!req.user) throw new UnauthorizedException();
    // F1.2: Company-aware, ADDITIVE contract (identity/platform/company/membership/capabilities/scopes/entitlements/policyFlags/authzVersion/legacyRoles).
    // The legacy fields (id/email/fullName/roles) keep their meaning. Nothing here is an authority — see AuthMeView.
    return { success: true, data: await this.authMe.build(req) };
  }

  /**
   * Bootstrap-only when no user exists yet (creates the first user, who
   * becomes admin automatically — see AuthService.register). Once at
   * least one user exists, this route requires an authenticated admin
   * caller (V1 Release Audit BLOCKER fix: this was previously open to
   * any unauthenticated caller at any time, self-activating with no
   * invite/verification gate). There is no separate "create user" admin
   * endpoint, so this stays the one onboarding path rather than being
   * closed outright — it just stops being public past the first user.
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(@Req() req: Request, @Body() dto: RegisterDto) {
    const isFirstUser = (await this.users.count()) === 0;
    if (!isFirstUser) {
      await this.requireAdminCaller(req);
    }
    const user = await this.auth.register(dto.email, dto.fullName, dto.password);
    return { success: true, data: { id: user.id, email: user.email, fullName: user.fullName } };
  }

  private async requireAdminCaller(req: Request): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Registering additional users requires an authenticated admin.');
    }
    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(authHeader.slice('Bearer '.length), { secret: this.config.auth.accessSecret, ...JWT_VERIFY_OPTIONS });
    } catch {
      throw new UnauthorizedException('Invalid or expired token.');
    }
    const roles = await this.authorization.getRoleKeysForUser(payload.sub);
    if (!roles.includes('admin')) {
      throw new ForbiddenException('Only an admin may register additional users.');
    }
  }

  /**
   * Rate-limited per IP (default 10/minute, live-configurable — see
   * `resolveAuthRateLimit`'s own doc comment, AUDIT-SEC-26) — the
   * brute-force backstop `AuthService.login` itself never had (it fails
   * safely per-attempt, generic "Invalid email or password", no user
   * enumeration, but had no mechanism to slow down repeated attempts
   * against the same or different accounts). Default loose enough not to
   * lock out a shared-office IP with several staff logging in around the
   * same time — an operator can tighten it live via
   * `core.security.rate_limit.auth_per_minute` during a real incident.
   */
  @Throttle({ default: { limit: resolveAuthRateLimit, ttl: 60_000 } })
  @Post('login')
  async login(@Body() dto: LoginDto) {
    const tokens = await this.auth.login(dto.email, dto.password);
    return { success: true, data: tokens };
  }

  @Post('refresh')
  async refresh(@Body() dto: RefreshDto) {
    const tokens = await this.auth.refresh(dto.refreshToken);
    return { success: true, data: tokens };
  }

  /**
   * Multi-Company Area 5 (2026-09-23, locked decision). Issues a fresh,
   * Company-scoped token pair — the ONLY way a session acquires or
   * switches its Company context. Requires an already-authenticated
   * (base) token; `AuthService.selectCompany` itself validates
   * `Membership` before issuing anything, but that is a one-time gate at
   * mint time, not a substitute for `CompanyContextGuard`'s per-request
   * re-check on every subsequent Company-scoped request.
   */
  @UseGuards(JwtAuthGuard)
  @Post('select-company')
  async selectCompany(@Req() req: AuthenticatedRequest, @Body() dto: SelectCompanyDto) {
    if (!req.user) throw new UnauthorizedException();
    const tokens = await this.auth.selectCompany(req.user.id, dto.companyId);
    return { success: true, data: tokens };
  }

  @Post('logout')
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
    return { success: true, data: { loggedOut: true } };
  }

  /**
   * SEC-08 (red-team RT12): rate-limited AND re-authenticated. `setPassword`
   * (no current-password proof) remains the admin/bootstrap primitive; this
   * user-facing route goes through `changeOwnPassword`, which verifies the
   * current password first. Changing the password still revokes every
   * refresh-token family for the user (`setPassword`'s existing behaviour).
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  async changePassword(@Req() req: AuthenticatedRequest, @Body() dto: ChangePasswordDto) {
    if (!req.user) throw new UnauthorizedException();
    await this.auth.changeOwnPassword(req.user.id, dto.currentPassword, dto.newPassword);
    return { success: true, data: { changed: true } };
  }
}
