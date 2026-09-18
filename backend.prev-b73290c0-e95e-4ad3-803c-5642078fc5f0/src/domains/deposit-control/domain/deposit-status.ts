/** Deposit Control — Stage 2 build-order item 26. Daii/architecture/DAII_DOMAIN_BOUNDARIES.md §5, blueprint §15. */
export type DepositStatus = 'submitted' | 'approved' | 'rejected';

const ALLOWED_TRANSITIONS: Record<DepositStatus, DepositStatus[]> = {
  submitted: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

export function canTransitionDepositStatus(from: DepositStatus, to: DepositStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
