/** Same active/inactive shape as Warehouse status — an inactive account cannot receive new transactions. */
export type TreasuryAccountStatus = 'active' | 'inactive';

const ALLOWED_TRANSITIONS: Record<TreasuryAccountStatus, TreasuryAccountStatus[]> = {
  active: ['inactive'],
  inactive: ['active'],
};

export function canTransitionTreasuryAccountStatus(from: TreasuryAccountStatus, to: TreasuryAccountStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
