import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * Returns — Stage 2 build-order item 32. Daii/architecture/DAII_DOMAIN_BOUNDARIES.md §11.
 *
 * A FOURTH real workflow on the generic Process Engine (Sales Order
 * approval, Fulfillment pick/pack, Shipment lifecycle, now Returns) —
 * ADR-008's reusability claim holding across every domain that needs a
 * workflow, exactly as designed. No source contributed anything here
 * (confirmed gap across all three Stage 0 audits, blueprint §29) — the
 * state list itself is new design, informed by blueprint §29's flow.
 */
export const RETURN_PROCESS: ProcessDefinition = {
  key: 'return_request',
  initialState: 'requested',
  transitions: [
    { from: 'requested', to: 'authorized', action: 'authorize' },
    { from: 'requested', to: 'rejected', action: 'reject' },
    { from: 'authorized', to: 'received', action: 'receive_at_warehouse' },
    { from: 'received', to: 'inspected', action: 'inspect' },
    { from: 'inspected', to: 'dispositioned', action: 'disposition' },
  ],
};
