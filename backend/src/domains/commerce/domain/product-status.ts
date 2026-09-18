/**
 * Commerce — Stage 2 build-order item 21. Daii/architecture/DAII_DOMAIN_BOUNDARIES.md §1.
 *
 * Platform UX Improvement Track, Item 1 (2026-09-12): `discontinued` was originally terminal —
 * a stopped product could never be brought back, and the only way to sell it again was creating a
 * new record (losing its id, its price-list/BOM/integration-mapping references, and its historical
 * movement). `discontinued -> active` is now allowed, mirroring `PriceListStatus`'s own bidirectional
 * `active <-> inactive` toggle: "was live, taken down, brought back" is a normal, expected operation
 * for a catalog item, not a mistake to recover from via a fresh record. `discontinued -> draft` is
 * deliberately NOT added — reactivation always returns a product straight to sellable, not back to
 * an unfinished-setup state.
 */
export type ProductStatus = 'draft' | 'active' | 'discontinued';

const ALLOWED_TRANSITIONS: Record<ProductStatus, ProductStatus[]> = {
  draft: ['active'],
  active: ['discontinued'],
  discontinued: ['active'],
};

export function canTransitionProductStatus(from: ProductStatus, to: ProductStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
