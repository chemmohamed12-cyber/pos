/**
 * Commerce — Price Lists (Gap G-3, planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md).
 * Daii/architecture/DAII_DOMAIN_BOUNDARIES.md §1 (`price_lists` is an
 * explicitly listed Commerce-owned entity).
 *
 * Unlike Product's one-way `draft -> active -> discontinued` ratchet, a
 * Price List has no meaningful "draft" phase — it is either in effect or
 * not, and toggling it back on (e.g. a seasonal price book reused next
 * year) is a normal, expected operation, so both directions are allowed.
 */
export type PriceListStatus = 'active' | 'inactive';

const ALLOWED_TRANSITIONS: Record<PriceListStatus, PriceListStatus[]> = {
  active: ['inactive'],
  inactive: ['active'],
};

export function canTransitionPriceListStatus(from: PriceListStatus, to: PriceListStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
