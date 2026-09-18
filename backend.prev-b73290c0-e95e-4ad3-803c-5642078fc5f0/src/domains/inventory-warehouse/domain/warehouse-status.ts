/**
 * Warehouse ERP V1 / Phase 1 Integration (CTO directive §3) — a
 * warehouse has no meaningful "draft" phase (unlike Product's
 * draft->active->discontinued ratchet): it is either in active use or
 * taken out of service, and either direction is a normal operational
 * event (e.g. a seasonal overflow site reopened next year) — same
 * symmetric two-state shape as `price-list-status.ts`.
 */
export type WarehouseStatus = 'active' | 'inactive';

const ALLOWED_TRANSITIONS: Record<WarehouseStatus, WarehouseStatus[]> = {
  active: ['inactive'],
  inactive: ['active'],
};

export function canTransitionWarehouseStatus(from: WarehouseStatus, to: WarehouseStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
