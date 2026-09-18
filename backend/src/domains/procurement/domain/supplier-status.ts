/** Same active/inactive shape as Warehouse/TreasuryAccount status — an inactive supplier cannot receive new Purchase Orders. */
export type SupplierStatus = 'active' | 'inactive';

const ALLOWED_TRANSITIONS: Record<SupplierStatus, SupplierStatus[]> = {
  active: ['inactive'],
  inactive: ['active'],
};

export function canTransitionSupplierStatus(from: SupplierStatus, to: SupplierStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
