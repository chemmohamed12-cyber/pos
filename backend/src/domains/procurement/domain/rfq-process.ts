import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * ADR-048 — Path B: RFQ lifecycle. `award` is fired only internally by
 * `RfqService`'s own approval-decision subscriber, after the Evaluation/
 * Approval step (Approval Engine) approves a specific quotation — never a
 * raw client action, the same discipline `AP_ADJUSTMENT_APPROVED_EVENT`'s
 * subscriber already uses in `ApAdjustmentService`.
 */
export const RFQ_PROCESS: ProcessDefinition = {
  key: 'rfq_lifecycle',
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'sent', action: 'send' },
    { from: 'sent', to: 'awarded', action: 'award' },
    { from: 'draft', to: 'cancelled', action: 'cancel' },
    { from: 'sent', to: 'cancelled', action: 'cancel' },
  ],
};
