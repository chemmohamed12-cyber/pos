/** Commerce — Stage 2 build-order item 21. Daii/architecture/DAII_DOMAIN_BOUNDARIES.md §1. */
export type ProductStatus = 'draft' | 'active' | 'discontinued';

const ALLOWED_TRANSITIONS: Record<ProductStatus, ProductStatus[]> = {
  draft: ['active'],
  active: ['discontinued'],
  discontinued: [],
};

export function canTransitionProductStatus(from: ProductStatus, to: ProductStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
