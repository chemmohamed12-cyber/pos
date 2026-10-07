import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { PermissionAccess } from '../permission/role-permission.entity';
import { ROLES_METADATA_KEY } from '../authorization/require-role.decorator';

export const PLATFORM_PERMISSION_KEY = 'daii:required-platform-permission';

export interface RequiredPlatformPermission {
  node: string;
  access: PermissionAccess;
  /** Legacy node(s) that were this route's ONLY gate before F4 and stay accepted during the compatibility window. Opt-in per route: a route that required a legacy node AND the `admin` role must not be loosened. */
  legacyNodes?: string[];
}

/** Marks a route as requiring a PLATFORM capability (`platform.*`), resolved only from the control-plane roles. */
export const RequirePlatform = (node: string, access: PermissionAccess = 'read-only', opts?: { legacyNodes?: string[] }) =>
  SetMetadata(PLATFORM_PERMISSION_KEY, { node, access, legacyNodes: opts?.legacyNodes } as RequiredPlatformPermission);

/**
 * Authorization Foundation F4 — authorization of the PLATFORM plane. Runs after `JwtAuthGuard`; it never runs `CompanyContextGuard`, so it resolves ONLY the
 * control-plane (ambient) roles of the caller — a Company role can never satisfy it and, symmetrically, holding platform power gives nothing inside a Company.
 *
 * Allowed when ANY of (the compatibility window — Map → Dual-check → Migrate → Retire):
 *  1. the caller holds the `platform.*` node at the required level (the target model);
 *  2. the route opted in to a LEGACY node (`legacyNodes`, only where that node was the route's sole gate before F4) and the caller holds it at that level;
 *  3. the caller holds the legacy ambient `admin` role (today's single platform super-user; granted every platform node too, kept as an alias until F5).
 * A route that declares no platform permission falls back to its legacy `@RequireRole` (the one remaining role-gated platform-adjacent route, `/admin/sales-reps`,
 * moves in F5); with neither it is DENIED (fail closed) — a forgotten decorator can never open a platform route.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly contexts: AuthorizationContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RequiredPlatformPermission>(PLATFORM_PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<{ user?: { id: string } }>();
    if (!request.user) throw new UnauthorizedException('Authentication required before platform authorization can be checked.');
    const ctx = await this.contexts.load(request.user.id, null); // ambient (control-plane) authority only — never a Company database
    if (!required) {
      const roles = this.reflector.getAllAndOverride<string[]>(ROLES_METADATA_KEY, [context.getHandler(), context.getClass()]);
      if (!roles || roles.length === 0) throw new ForbiddenException('This platform route declares no platform permission.');
      if (!roles.some((r) => ctx.hasRole(r))) throw new ForbiddenException('Insufficient role for this action.');
      return true;
    }
    const allowed = ctx.hasAtLeast(required.node, required.access) || (required.legacyNodes ?? []).some((n) => ctx.hasAtLeast(n, required.access)) || ctx.hasRole('admin');
    if (!allowed) throw new ForbiddenException('Insufficient platform permission for this action.');
    return true;
  }
}
