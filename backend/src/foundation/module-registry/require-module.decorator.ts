import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException, Optional, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ENTITLEMENT_RESOLVER, EntitlementResolver } from './entitlement-resolver.token';
import { AuthoredModuleCode } from './module-manifest.type';

/**
 * ERP Foundation — Module-entitlement guard.
 *
 * P1: introduced as an always-allow no-op (the ENTITLEMENT_RESOLVER token was
 * unbound).
 * P3: the Entitlement Engine binds ENTITLEMENT_RESOLVER. When bound, an
 * un-entitled module_code → 404 (NotFoundException — anti-enumeration,
 * ADR-023 §3, TENANT_ENTITLEMENT_PERMISSION_MODEL.md §6). When unbound
 * (entitlement disabled / not loaded), behaviour is unchanged from P1.
 *
 * This is NOT a permission check — permission is the separate
 * `@RequirePermission` guard, checked *after* this one (Edition ≠ Permission).
 */
export const REQUIRE_MODULE_METADATA_KEY = 'daii:require-module';

/** Marks a route/controller as belonging to the given commercial module. */
export const RequireModule = (moduleCode: AuthoredModuleCode) => SetMetadata(REQUIRE_MODULE_METADATA_KEY, moduleCode);

@Injectable()
export class RequireModuleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(ENTITLEMENT_RESOLVER) private readonly entitlement?: EntitlementResolver,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.entitlement) return true; // P1/P2 state — unchanged
    const code =
      this.reflector.get<AuthoredModuleCode>(REQUIRE_MODULE_METADATA_KEY, context.getHandler()) ??
      this.reflector.get<AuthoredModuleCode>(REQUIRE_MODULE_METADATA_KEY, context.getClass());
    if (!code) return true;
    if (!this.entitlement.isModuleEntitled(code)) throw new NotFoundException();
    return true;
  }
}
