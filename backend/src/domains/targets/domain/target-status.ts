/** ADR-071 §6 — driven by `ProcessEngineService`, not a bespoke status column. */
export type TargetStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected';

export const TARGET_PROCESS_KEY = 'target';
