import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException, Optional, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { COMPANY_ENTITLEMENT_RESOLVER, CompanyEntitlementResolver, ENTITLEMENT_RESOLVER, EntitlementResolver } from './entitlement-resolver.token';

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
    @Optional() @Inject(COMPANY_ENTITLEMENT_RESOLVER) private readonly companyEntitlement?: CompanyEntitlementResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.entitlement) return true;
    const code =
      this.reflector.get<string>(REQUIRE_FEATURE_METADATA_KEY, context.getHandler()) ??
      this.reflector.get<string>(REQUIRE_FEATURE_METADATA_KEY, context.getClass());
    if (!code) return true;
    // See RequireModuleGuard: only the Membership-validated `request.companyContext` id selects a Company.
    const companyId = context.switchToHttp().getRequest<{ companyContext?: { companyId?: string } }>().companyContext?.companyId;
    const entitled =
      companyId && this.companyEntitlement
        ? await this.companyEntitlement.isFeatureEntitled(companyId, code)
        : this.entitlement.isFeatureEntitled(code);
    if (!entitled) throw new NotFoundException();
    return true;
  }
}
