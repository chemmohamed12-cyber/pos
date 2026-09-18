import { ProcessDefinition } from '../process-engine/process-definition';

/**
 * FA-01 — Generic Approval / Maker-Checker Foundation
 * (`architecture/APPROVAL_ENGINE_CONTRACT.md` §4, ADR-033).
 *
 * ONE fixed, generic `ProcessDefinition`, registered once, reused by every
 * `ApprovalRequest` regardless of which module created it. The Approval
 * Engine never mutates `ApprovalRequest` state directly — it always calls
 * `ProcessEngineService.transition(APPROVAL_PROCESS, 'ApprovalRequest',
 * requestId, action, actorUserId, manager)` and reads the result back.
 *
 * V1 semantics (contract §6):
 *   - any-of-N approval, NOT a strict ordered chain — `approve` fires once
 *     `resolvedMinApprovers` distinct valid `approved` decisions exist;
 *   - rejection is terminal and immediate — `reject` fires on the FIRST
 *     valid `rejected` decision, the engine does not wait for the rest;
 *   - `escalate` ships as a state + transition but is manual-only in V1
 *     (no timer fires it — future extension);
 *   - `expire` is fired only by the scheduled sweep (TTL-driven).
 */
export const APPROVAL_PROCESS: ProcessDefinition = {
  key: 'generic_approval_request',
  initialState: 'pending',
  transitions: [
    { from: 'pending', to: 'approved', action: 'approve' },
    { from: 'pending', to: 'rejected', action: 'reject' },
    { from: 'pending', to: 'withdrawn', action: 'withdraw' },
    { from: 'pending', to: 'escalated', action: 'escalate' },
    { from: 'pending', to: 'expired', action: 'expire' },
  ],
};

export const APPROVAL_REQUEST_ENTITY_TYPE = 'ApprovalRequest';

export type ApprovalRequestState = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'escalated' | 'expired';

/** States from which no further transition is possible (terminal). */
export const TERMINAL_APPROVAL_STATES: ReadonlySet<ApprovalRequestState> = new Set<ApprovalRequestState>([
  'approved',
  'rejected',
  'withdrawn',
  'escalated',
  'expired',
]);

export type ApprovalDecisionValue = 'approved' | 'rejected';
