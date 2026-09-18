import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * A NEW, additive Process Definition — reuses the same generic Process
 * Engine every other document in this codebase uses (ADR-008), never a
 * bespoke status column. Deliberately minimal (2 real states): the
 * directive's own scope for this batch is the DOCUMENT model's
 * relationships and quantity/eligibility integrity, not a multi-step
 * physical inspection workflow — `complete` is where the restock
 * movement + quantity validation happen atomically (see
 * `ShipmentReturnsService.complete`). Disclosed V1 simplification, not a
 * silent omission of `ReturnRequest`'s richer requested→...→dispositioned
 * flow, which this entity deliberately does NOT reuse (CTO ratification:
 * "leave ReturnRequest completely untouched").
 */
export const SHIPMENT_RETURN_PROCESS: ProcessDefinition = {
  key: 'shipment_return',
  initialState: 'requested',
  transitions: [
    { from: 'requested', to: 'completed', action: 'complete' },
    { from: 'requested', to: 'rejected', action: 'reject' },
  ],
};
