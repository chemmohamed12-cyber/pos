/**
 * Company lifecycle — Multi-Company Phase 3 V7, Area 2 (Company Registry).
 * Literal state chain per V7's own Required field:
 * `PROVISIONING → READY → DEGRADED/SUSPENDED/MIGRATING/FAILED → DECOMMISSIONED`,
 * plus reactivation back to READY from any of those four operational states.
 *
 * Area 2/Area 19 decision (recorded 2026-09-22): DEGRADED/SUSPENDED/
 * MIGRATING/FAILED may all transition directly back to READY
 * ("reactivation") — no distinct policy for FAILED. READY →
 * DECOMMISSIONED directly is still NOT allowed; decommissioning a READY
 * Company must pass through one of the four intermediate states first.
 * This is an explicit decision, not an inference — do not add further
 * arrows without one.
 */
export type CompanyStatus = 'PROVISIONING' | 'READY' | 'DEGRADED' | 'SUSPENDED' | 'MIGRATING' | 'FAILED' | 'DECOMMISSIONED';

export const COMPANY_STATUSES: readonly CompanyStatus[] = [
  'PROVISIONING',
  'READY',
  'DEGRADED',
  'SUSPENDED',
  'MIGRATING',
  'FAILED',
  'DECOMMISSIONED',
];

const ALLOWED_TRANSITIONS: Readonly<Record<CompanyStatus, readonly CompanyStatus[]>> = {
  PROVISIONING: ['READY'],
  READY: ['DEGRADED', 'SUSPENDED', 'MIGRATING', 'FAILED'],
  DEGRADED: ['READY', 'DECOMMISSIONED'],
  SUSPENDED: ['READY', 'DECOMMISSIONED'],
  MIGRATING: ['READY', 'DECOMMISSIONED'],
  FAILED: ['READY', 'DECOMMISSIONED'],
  DECOMMISSIONED: [],
};

export function isValidCompanyTransition(from: CompanyStatus, to: CompanyStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** V7 Area 2: "A company is never visible to end users before READY." Narrow, literal reading — only PROVISIONING is hidden. */
export function isCompanyVisible(status: CompanyStatus): boolean {
  return status !== 'PROVISIONING';
}
