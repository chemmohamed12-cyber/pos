import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/** Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16). Same minimal-lifecycle rationale as `SHIPMENT_RETURN_PROCESS` — see its own doc comment. */
export const SALES_RETURN_PROCESS: ProcessDefinition = {
  key: 'sales_return',
  initialState: 'requested',
  transitions: [
    { from: 'requested', to: 'completed', action: 'complete' },
    { from: 'requested', to: 'rejected', action: 'reject' },
  ],
};
