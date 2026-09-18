import { Inject, Injectable, Optional } from '@nestjs/common';
import { ENTITLEMENT_RESOLVER, EntitlementResolver } from '../module-registry/entitlement-resolver.token';

/**
 * The active-edition provider — feeds the P2 config resolver's EDITION
 * precedence layer. P2_BLUEPRINT.md §3.1, P3_BLUEPRINT.md §4.
 *
 * P2 shipped `NullActiveEditionProvider` (always null — the EDITION layer was
 * inert). P3 replaces the module binding with `EntitlementActiveEditionProvider`,
 * which reads the active edition from the Entitlement Engine via the
 * `@Optional()` resolver token — so the Configuration Engine still works with
 * no cycle and with entitlement absent.
 */
export const ACTIVE_EDITION_PROVIDER = 'daii:config:active-edition-provider';

export interface ActiveEditionProvider {
  getActiveEditionCode(): string | null;
}

export class NullActiveEditionProvider implements ActiveEditionProvider {
  getActiveEditionCode(): null {
    return null;
  }
}

@Injectable()
export class EntitlementActiveEditionProvider implements ActiveEditionProvider {
  constructor(@Optional() @Inject(ENTITLEMENT_RESOLVER) private readonly resolver?: EntitlementResolver) {}

  getActiveEditionCode(): string | null {
    return this.resolver?.activeEditionCode() ?? null;
  }
}
