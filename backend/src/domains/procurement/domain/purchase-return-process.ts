import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * Phase D-1 (D7) - Purchase Return lifecycle: Draft -> Submitted -> Approved -> Posted, with Rejected (back to Draft through `reopen`) and Void for a document that never posted.
 * `post` is the one place stock leaves and the accounting event is published; a posted return has no outgoing transition (a correction is a new document).
 */
export const PURCHASE_RETURN_PROCESS: ProcessDefinition = {
  key: 'purchase_return_lifecycle',
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'submitted', action: 'submit' },
    { from: 'submitted', to: 'approved', action: 'approve' },
    { from: 'submitted', to: 'rejected', action: 'reject' },
    { from: 'rejected', to: 'draft', action: 'reopen' },
    { from: 'approved', to: 'posted', action: 'post' },
    { from: 'draft', to: 'void', action: 'cancel' },
    { from: 'submitted', to: 'void', action: 'cancel' },
    { from: 'approved', to: 'void', action: 'cancel' },
    { from: 'rejected', to: 'void', action: 'cancel' },
  ],
};
