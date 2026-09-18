import { Injectable } from '@nestjs/common';
import { NavGroup, NAVIGATION_REGISTRY } from './navigation-registry';
import { EntitlementService } from '../entitlement/entitlement.service';
import { PermissionService } from '../permission/permission.service';
import { AuthorizationService } from '../authorization/authorization.service';

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
  ) {}

  /** `registry` defaults to the real `NAVIGATION_REGISTRY` — overridable only so tests can exercise each gate type in isolation with a small synthetic registry; every real caller uses the default. */
  async resolveFor(userId: string, registry: readonly NavGroup[] = NAVIGATION_REGISTRY): Promise<NavGroupView[]> {
    const resolved = this.entitlement.resolve();
    const userRoles = await this.authorization.getRoleKeysForUser(userId);

    const groups: NavGroupView[] = [];
    for (const group of registry) {
      const items: NavItemView[] = [];
      for (const item of group.items) {
        if (item.module && !resolved.modules.has(item.module)) continue;
        if (item.feature && !resolved.features.has(item.feature)) continue;
        if (item.permissionNode && !(await this.permission.hasAtLeast(userId, item.permissionNode, 'read-only'))) continue;
        if (item.roles && !item.roles.some((r) => userRoles.includes(r))) continue;
        items.push({ to: item.to, code: item.code });
      }
      if (items.length > 0) {
        groups.push({ code: group.code, coverTo: group.coverTo, items });
      }
    }
    return groups;
  }

  /** Every terminology code referenced anywhere in the FULL registry (not just what one user sees) — lets the SPA preload every possible label once, same as `Layout.tsx`'s prior `ALL_CODES` did. Static, no principal needed. */
  static allTerminologyCodes(): string[] {
    const codes = NAVIGATION_REGISTRY.flatMap((g: NavGroup) => [g.code, ...g.items.map((i) => i.code)]);
    return [...new Set(codes.filter(Boolean))];
  }
}
