import { Injectable, Optional } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { NavGroup, NAVIGATION_REGISTRY } from './navigation-registry';
import { EntitlementService } from '../entitlement/entitlement.service';
import { PermissionService } from '../permission/permission.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { CompanyEntitlementService } from '../plans/company-entitlement.service';
import { AuthorizationContext } from '../authorization/authorization-context';
import { WorkflowAccess } from '../authorization/workflow-access';

export interface NavItemView {
  to: string;
  code: string;
}
export interface NavGroupView {
  code: string;
  coverTo?: string;
  items: NavItemView[];
}

/**
 * ERP Foundation — P7. Resolves `NAVIGATION_REGISTRY` against the current
 * principal — Module → Feature → Entitlement → Permission → Navigation,
 * per the CTO's explicit chain. Returns ONLY what the principal may see:
 * the SPA does zero authorization logic of its own (`navigation-registry.ts`'s
 * doc comment, §"no frontend authorization as substitute").
 */
@Injectable()
export class NavigationService {
  constructor(
    private readonly entitlement: EntitlementService,
    private readonly permission: PermissionService,
    private readonly authorization: AuthorizationService,
    @Optional() private readonly companyEntitlement?: CompanyEntitlementService,
  ) {}

  /** `registry` defaults to the real `NAVIGATION_REGISTRY` — overridable only so tests can exercise each gate type in isolation with a small synthetic registry; every real caller uses the default. */
  async resolveFor(
    userId: string,
    registry: readonly NavGroup[] = NAVIGATION_REGISTRY,
    /** A Membership-VALIDATED Company (see `CompanyViewContextService`) — when present, entitlement is the Company's package and roles/permissions come from the Company's own database. */
    company?: { companyId: string; manager: EntityManager } | null,
    /** F1.4 — the request-scoped AuthorizationContext (one load for the whole request). When supplied, every role/permission check below is an in-memory lookup; when absent (legacy callers/specs) the pre-F1 per-check queries run unchanged. */
    ctx?: AuthorizationContext,
  ): Promise<NavGroupView[]> {
    const resolved =
      company && this.companyEntitlement ? await this.companyEntitlement.resolve(company.companyId) : this.entitlement.resolve();
    const manager = company?.manager;
    const userRoles = ctx ? ctx.roleKeys : await this.authorization.getRoleKeysForUser(userId, manager);
    // F5: workflow rules are decided by the SAME single load (the request context) — one extra query only for legacy callers without one.

    const groups: NavGroupView[] = [];
    for (const group of registry) {
      const items: NavItemView[] = [];
      for (const item of group.items) {
        if (item.module && !resolved.modules.has(item.module)) continue;
        if (item.feature && !resolved.features.has(item.feature)) continue;
        if (item.permissionNode && !(ctx ? ctx.hasAtLeast(item.permissionNode, 'read-only') : await this.permission.hasAtLeast(userId, item.permissionNode, 'read-only', manager))) continue;
        if (item.roles && !item.roles.some((r) => userRoles.includes(r))) continue;
        if (item.workflowRule && !(await this.workflowFor(ctx, userId, manager)).allows(item.workflowRule)) continue;
        items.push({ to: item.to, code: item.code });
      }
      if (items.length > 0) {
        groups.push({ code: group.code, coverTo: group.coverTo, items });
      }
    }
    return groups;
  }

  private workflowCache = new WeakMap<object, WorkflowAccess>();

  private async workflowFor(ctx: AuthorizationContext | undefined, userId: string, manager?: EntityManager): Promise<WorkflowAccess> {
    if (ctx) {
      let w = this.workflowCache.get(ctx);
      if (!w) { w = new WorkflowAccess(ctx); this.workflowCache.set(ctx, w); }
      return w;
    }
    return this.authorization.workflowAccess(userId, manager);
  }

  /** Every terminology code referenced anywhere in the FULL registry (not just what one user sees) — lets the SPA preload every possible label once, same as `Layout.tsx`'s prior `ALL_CODES` did. Static, no principal needed. */
  static allTerminologyCodes(): string[] {
    const codes = NAVIGATION_REGISTRY.flatMap((g: NavGroup) => [g.code, ...g.items.map((i) => i.code)]);
    return [...new Set(codes.filter(Boolean))];
  }
}
