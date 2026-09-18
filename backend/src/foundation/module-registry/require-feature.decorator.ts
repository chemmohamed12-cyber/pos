import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException, Optional, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ENTITLEMENT_RESOLVER, EntitlementResolver } from './entitlement-resolver.token';

/**
 * ERP Foundation — Feature-entitlement guard.
 *
 * P1: always-allow no-op. P3: when the Entitlement Engine binds
 * ENTITLEMENT_RESOLVER, an un-entitled feature_code → 404. A feature whose
 * manifest entry is `toggleable:false` is a structural grouping and the
 * resolver reports it as always entitled. Unbound → unchanged from P1.
 */
export const REQUIRE_FEATURE_METADATA_KEY = 'daii:require-feature';

/** Marks a route as requiring the given feature (`<module_code>.<feature>`) to be entitled. */
export const RequireFeature = (featureCode: string) => SetMetadata(REQUIRE_FEATURE_METADATA_KEY, featureCode);

@Injectable()
export class RequireFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(ENTITLEMENT_RESOLVER) private readonly entitlement?: EntitlementResolver,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.entitlement) return true;
    const code =
      this.reflector.get<string>(REQUIRE_FEATURE_METADATA_KEY, context.getHandler()) ??
      this.reflector.get<string>(REQUIRE_FEATURE_METADATA_KEY, context.getClass());
    if (!code) return true;
    if (!this.entitlement.isFeatureEntitled(code)) throw new NotFoundException();
    return true;
  }
}
