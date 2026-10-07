import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizationService } from './authorization.service';
import { AuthorizationContextService } from './authorization-context.service';
import { ROLES_METADATA_KEY, WORKFLOW_RULE_METADATA_KEY } from './require-role.decorator';
import { WorkflowAccess } from './workflow-access';
import { CompanyScopedRequest } from '../company/company-context.guard';

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
    /** F1.1 — when present (always, under Nest DI) the roles come from the request-scoped AuthorizationContext (one load per request, shared with PermissionGuard). Optional only so legacy unit specs can construct the guard without it. */
    @Optional() private readonly contexts?: AuthorizationContextService,
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
    // F5: a route may name a workflow rule (capability) instead of a role list; the rule is decided under the active mode by the request's single context load.
    const requiredRule = this.reflector.getAllAndOverride<string | undefined>(WORKFLOW_RULE_METADATA_KEY, [context.getHandler(), context.getClass()]);
    if (typeof requiredRule === 'string' && requiredRule) {
      const req = context.switchToHttp().getRequest<CompanyScopedRequest>();
      if (!req.user) throw new UnauthorizedException('Authentication required before authorization can be checked.');
      if (!this.contexts) throw new ForbiddenException('Insufficient role for this action.');
      const access = new WorkflowAccess(await this.contexts.forRequest(req));
      if (!access.allows(requiredRule)) throw new ForbiddenException('Insufficient role for this action.');
      return true;
    }
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<CompanyScopedRequest>();
    if (!request.user) {
      throw new UnauthorizedException('Authentication required before authorization can be checked.');
    }

    // Multi-Company Area 6 (2026-09-23) — when `CompanyContextGuard` ran
    // earlier in this route's guard chain, it already validated Membership
    // and resolved this Company's own DataSource; routing the role lookup
    // through it (rather than the ambient connection) is what makes the
    // Company boundary structural. Routes without `CompanyContextGuard`
    // are unaffected — `manager` is simply `undefined`.
    const manager = request.companyContext?.dataSource.manager;
    const userRoles = this.contexts ? (await this.contexts.forRequest(request)).roleKeys : await this.authorization.getRoleKeysForUser(request.user.id, manager);
    const authorized = requiredRoles.some((role) => userRoles.includes(role));
    if (!authorized) {
      throw new ForbiddenException('Insufficient role for this action.');
    }
    return true;
  }
}
