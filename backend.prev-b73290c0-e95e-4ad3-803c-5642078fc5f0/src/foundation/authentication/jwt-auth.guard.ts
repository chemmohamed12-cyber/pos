import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { UsersService } from '../identity/users.service';
import { AppConfigService } from '../configuration/app-config.service';
import { JWT_VERIFY_OPTIONS } from './jwt-constants';

export interface AuthenticatedRequest extends Request {
  user: { id: string; email: string };
}

/**
 * The "required" enforcement tier only (DAII_SECURITY_ARCHITECTURE.md §2's
 * requireAuth/optionalAuth two-tier pattern) — no route needs the
 * "optional" variant yet, so it isn't built (YAGNI per CTO Execution
 * Policy §3/§8: don't build for theoretical future scenarios). Add it
 * when a real route needs it.
 *
 * Re-checks account status on every request from the database (never
 * trusts a stale token claim) — fail-closed on any non-active status.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token.');
    }
    const token = authHeader.slice('Bearer '.length);

    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: this.config.auth.accessSecret, ...JWT_VERIFY_OPTIONS });
    } catch {
      throw new UnauthorizedException('Invalid or expired token.');
    }

    const user = await this.users.findById(payload.sub);
    if (user.status !== 'active') {
      throw new UnauthorizedException('Account is not active.');
    }

    request.user = { id: user.id, email: user.email };
    return true;
  }
}
