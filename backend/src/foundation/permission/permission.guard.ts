import { CanActivate, ExecutionContext, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionService } from './permission.service';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { PERMISSION_METADATA_KEY, RequiredPermission } from './require-permission.decorator';
import { CompanyScopedRequest } from '../company/company-context.guard';

/**
 * Permission Engine — Stage 2 build-order item 8.
 *
 * Deliberately throws 404 (NotFoundException), never 403, on denial —
 * anti-enumeration discipline adopted directly from xnexus-website's
 * consistently-verified pattern (Daii/_source-audits/xnexus-website/,
 * DAII_SECURITY_ARCHITECTURE.md §3): a non-owner never learns the
 * resource exists. This is the one deliberate difference from
 * RolesGuard (item 7), which throws 403 for its coarser admin/staff
 * role gate — Permission Engine guards actual business resources.
 *
 * Membership HTTP Management (2026-09-24) — REAL BUG FOUND & FIXED, same
 * class as `RolesGuard`'s own documented incident: `getAllAndOverride`,
 * not `get(..., getHandler())` alone. `CompanyMembershipController`
 * applies `@RequirePermission` at the CLASS level; a bare
 * `.get(key, context.getHandler())` never sees class-level metadata and
 * silently returned `undefined` — `if (!required) return true` then let
 * ANY authenticated, Company-context-validated caller through with zero
 * permission check on every route of that controller. Handler-level
 * metadata still wins when both are present, matching `RolesGuard`.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permission: PermissionService,
    /** F1.1 — request-scoped AuthorizationContext (one load per request, shared with RolesGuard/navigation). Optional only so legacy unit specs can construct the guard without it. */
    @Optional() private readonly contexts?: AuthorizationContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RequiredPermission>(PERMISSION_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<CompanyScopedRequest>();
    if (!request.user) {
      throw new UnauthorizedException('Authentication required before permission can be checked.');
    }

    // Multi-Company Area 6 (2026-09-23) — see RolesGuard's identical comment.
    const manager = request.companyContext?.dataSource.manager;
    // F1.1: with the context service (always, under Nest DI) the decision is an in-memory lookup on the request's single load; a load error propagates (deny — never allow).
    const allowed = this.contexts
      ? (await this.contexts.forRequest(request)).hasAtLeast(required.nodeKey, required.access)
      : await this.permission.hasAtLeast(request.user.id, required.nodeKey, required.access, manager);
    if (!allowed) {
      throw new NotFoundException();
    }
    return true;
  }
}
