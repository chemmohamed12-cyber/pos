/**
 * CRM / Customer Management — Stage 2 build-order item 22.
 * Daii/architecture/DAII_DOMAIN_BOUNDARIES.md §2, blueprint §10.
 *
 * Pure business rule, zero framework/persistence dependency (the
 * "domain" layer's whole point) — the allowed Customer status
 * transitions. Kept here rather than inline in the application service
 * so it's independently testable and so a future Sales Order flow that
 * needs to check "is this customer active" imports a rule, not a
 * TypeORM entity.
 */
export type CustomerStatus = 'pending' | 'active' | 'suspended';

const ALLOWED_TRANSITIONS: Record<CustomerStatus, CustomerStatus[]> = {
  pending: ['active'],
  active: ['suspended'],
  suspended: ['active'],
};

export function canTransitionCustomerStatus(from: CustomerStatus, to: CustomerStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
