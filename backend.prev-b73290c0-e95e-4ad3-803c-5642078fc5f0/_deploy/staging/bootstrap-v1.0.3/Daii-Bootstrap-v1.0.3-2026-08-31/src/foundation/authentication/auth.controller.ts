import { Body, Controller, ForbiddenException, Get, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard, AuthenticatedRequest } from './jwt-auth.guard';
import { UsersService } from '../identity/users.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { AppConfigService } from '../configuration/app-config.service';

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

class ChangePasswordDto {
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
  ) {}

  /** The frontend's one source of truth for "who is logged in, with which roles" — drives role-based navigation and permission-aware actions. */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@Req() req: AuthenticatedRequest) {
    if (!req.user) throw new UnauthorizedException();
    const user = await this.users.findById(req.user.id);
    const roles = await this.authorization.getRoleKeysForUser(req.user.id);
    return { success: true, data: { id: user.id, email: user.email, fullName: user.fullName, roles } };
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
      payload = await this.jwt.verifyAsync(authHeader.slice('Bearer '.length), { secret: this.config.auth.accessSecret });
    } catch {
      throw new UnauthorizedException('Invalid or expired token.');
    }
    const roles = await this.authorization.getRoleKeysForUser(payload.sub);
    if (!roles.includes('admin')) {
      throw new ForbiddenException('Only an admin may register additional users.');
    }
  }

  /**
   * Rate-limited to 10 attempts/minute per IP — the brute-force backstop
   * `AuthService.login` itself never had (it fails safely per-attempt,
   * generic "Invalid email or password", no user enumeration, but had no
   * mechanism to slow down repeated attempts against the same or
   * different accounts). Loose enough not to lock out a shared-office IP
   * with several staff logging in around the same time.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
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

  @Post('logout')
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
    return { success: true, data: { loggedOut: true } };
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  async changePassword(@Req() req: AuthenticatedRequest, @Body() dto: ChangePasswordDto) {
    if (!req.user) throw new UnauthorizedException();
    await this.auth.setPassword(req.user.id, dto.newPassword);
    return { success: true, data: { changed: true } };
  }
}
