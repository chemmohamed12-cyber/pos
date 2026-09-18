/**
 * ERP Foundation — the seam between the always-present Module Registry (P1)
 * and the Entitlement Engine (P3). Defined HERE, in the lowest layer, so the
 * P1 guards and the P2 Configuration Engine can consult entitlement WITHOUT
 * creating an import cycle (they `@Optional() @Inject` this token; the
 * Entitlement module binds it).
 *
 * When the token is not bound (P1 / P2 state, or entitlement disabled), the
 * consumers behave exactly as before P3 — the guards allow, the config
 * EDITION layer is inert.
 */
export const ENTITLEMENT_RESOLVER = 'daii:entitlement-resolver';

export interface EntitlementResolver {
  /** True if the installation's Edition entitles this module_code. */
  isModuleEntitled(moduleCode: string): boolean;
  /** True if the Edition entitles this feature_code (a non-toggleable feature is always true). */
  isFeatureEntitled(featureCode: string): boolean;
  /** The installation's active edition code (for the P2 config EDITION precedence layer). */
  activeEditionCode(): string | null;
}
