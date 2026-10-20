import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * C4 (ADR-INV-01) - the Opening Balance Batch lifecycle. `submit` also starts the FA-01 approval request; `approve` / `reject` are fired by the approval engine's
 * outcome (never by a user directly); `post` is a separate, explicit, idempotent action AFTER approval (an approved-but-unposted batch is a legitimate, retryable state);
 * `reverse` is fired only when a REVERSAL batch is posted against it.
 */
export const OPENING_BATCH_PROCESS: ProcessDefinition = {
  key: 'inventory_opening_batch',
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'submitted', action: 'submit' },
    { from: 'submitted', to: 'draft', action: 'reject' },
    { from: 'submitted', to: 'approved', action: 'approve' },
    { from: 'approved', to: 'posted', action: 'post' },
    { from: 'posted', to: 'reversed', action: 'reverse' },
  ],
};

export const OPENING_BATCH_ENTITY_TYPE = 'InventoryOpeningBatch';
export const OPENING_BATCH_NUMBERING_SERIES = 'inventory_opening_batch';

/** FA-01 request types (one per kind) and the permission node each needs from its approvers (two distinct approvers, maker excluded by the engine). */
export const OPENING_BATCH_REQUEST_TYPES = {
  opening: { code: 'inventory.opening_batch', titleCode: 'action.inventory_opening_batch', node: 'inventory.opening_batch.approve' },
  reversal: { code: 'inventory.opening_batch_reversal', titleCode: 'action.inventory_opening_batch_reversal', node: 'inventory.opening_batch.correct' },
  correction: { code: 'inventory.opening_batch_correction', titleCode: 'action.inventory_opening_batch_correction', node: 'inventory.opening_batch.correct' },
} as const;
