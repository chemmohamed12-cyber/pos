import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * Phase D-2 (D6) - Supplier Credit Note lifecycle: Draft -> Submitted -> Approved -> Posted, with Rejected (back to Draft through `reopen`) and Void for a note that never posted.
 * A posted credit note has no outgoing transition: a correction is a new document.
 */
export const SUPPLIER_CREDIT_NOTE_PROCESS: ProcessDefinition = {
  key: 'supplier_credit_note_lifecycle',
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
