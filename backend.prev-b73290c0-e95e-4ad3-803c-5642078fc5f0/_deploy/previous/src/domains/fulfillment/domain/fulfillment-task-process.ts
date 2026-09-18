import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * Fulfillment — Stage 2 build-order item 28. Daii/architecture/DAII_DOMAIN_BOUNDARIES.md §7.
 *
 * A SECOND real business workflow consuming the same generic Process
 * Engine as Sales Orders' approval flow — direct proof of ADR-008's
 * central claim that the engine needs zero code changes per new
 * workflow, only a new data definition. Adapted from baseline's
 * "Universal Work Foundation" (work-engine.js, Class B,
 * Daii/_source-audits/baseline/): Assigned→Accepted→InProgress→
 * PendingVerification→Closed, with a rework loop and a cancel path.
 * Used for both Pick and Pack tasks (entityType differs: 'pick_task'
 * vs 'pack_task'), never duplicated per task type.
 */
export const FULFILLMENT_TASK_PROCESS: ProcessDefinition = {
  key: 'fulfillment_task',
  initialState: 'assigned',
  transitions: [
    { from: 'assigned', to: 'accepted', action: 'accept' },
    { from: 'accepted', to: 'in_progress', action: 'start' },
    { from: 'in_progress', to: 'pending_verification', action: 'complete' },
    { from: 'pending_verification', to: 'closed', action: 'verify' },
    { from: 'pending_verification', to: 'in_progress', action: 'reject_verification' },
    { from: 'assigned', to: 'cancelled', action: 'cancel' },
    { from: 'accepted', to: 'cancelled', action: 'cancel' },
  ],
};
