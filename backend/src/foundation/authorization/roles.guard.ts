import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizationService } from './authorization.service';
import { ROLES_METADATA_KEY } from './require-role.decorator';
import { AuthenticatedRequest } from '../authentication/jwt-auth.guard';

/**
 * Authorization — Stage 2 build-order item 7.
 *
 * Must run AFTER JwtAuthGuard (relies on req.user being populated).
 * Answers only "does this user hold one of the required roles" — not
 * "may this role perform this specific action" (Permission Engine,
 * item 8) and not "against which specific records" (Scope Engine,
 * item 9). Returning 403 here (not 404) is deliberate: role-gated
 * routes are coarse admin/staff boundaries, not the fine-grained
 * per-resource anti-enumeration case Permission/Scope will own.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // getAllAndOverride, not get(..., getHandler()) alone: SetMetadata applied
    // at the CLASS level (e.g. AdminController's `@RequireRole('admin')`)
    // attaches to the constructor, which `context.getHandler()` never sees —
    // a bare `.get(key, context.getHandler())` silently returned undefined
    // for every route on that controller and let ANY authenticated user
    // through (found live: /admin/users had no real role check at all).
    // Handler-level metadata still wins when both are present, same as
    // every other class+method `@RequireRole` pair in this codebase.
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new UnauthorizedException('Authentication required before authorization can be checked.');
    }

    const userRoles = await this.authorization.getRoleKeysForUser(request.user.id);
    const authorized = requiredRoles.some((role) => userRoles.includes(role));
    if (!authorized) {
      throw new ForbiddenException('Insufficient role for this action.');
    }
    return true;
  }
}
