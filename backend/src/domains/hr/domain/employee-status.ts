/**
 * ERP Foundation — P9 (ADR-029). Pure business rule, zero framework/
 * persistence dependency — the allowed Employee status transitions. Same
 * shape as `domains/crm/domain/customer-status.ts`.
 */
export type EmployeeStatus = 'active' | 'on_leave' | 'terminated';

const ALLOWED_TRANSITIONS: Record<EmployeeStatus, EmployeeStatus[]> = {
  active: ['on_leave', 'terminated'],
  on_leave: ['active', 'terminated'],
  terminated: [],
};

export function canTransitionEmployeeStatus(from: EmployeeStatus, to: EmployeeStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
