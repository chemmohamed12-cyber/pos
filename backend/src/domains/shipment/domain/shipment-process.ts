import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * Shipment — Stage 2 build-order item 29. Daii/architecture/DAII_DOMAIN_BOUNDARIES.md §8, blueprint §25.
 *
 * A THIRD real workflow on the same generic Process Engine (Sales Order
 * approval, Fulfillment pick/pack tasks, now Shipment lifecycle) — every
 * one a data definition, zero engine code changes, per ADR-008.
 *
 * SCOPE DECISION (disclosed, not silent): QR Platform's Delivery Dispatch
 * domain (Daii_source-audits/xnexus-website/) uses a separate Offer
 * entity with an atomic Accept/Reject race between drivers — the
 * highest-value single asset in the whole Stage 0 discovery. V1 here
 * uses direct dispatcher assignment instead (`assign_driver` action,
 * admin-gated) rather than the full offer/accept race model. This is a
 * deliberate V1 simplification, not a silent omission — the fuller
 * driver-offer/accept model remains valid future work (tracked as
 * backlog) once Daii has multiple competing drivers to dispatch among;
 * it is not required to satisfy blueprint §42's V1 minimum flow.
 */
export const SHIPMENT_PROCESS: ProcessDefinition = {
  key: 'shipment_lifecycle',
  initialState: 'created',
  transitions: [
    { from: 'created', to: 'assigned', action: 'assign_driver' },
    { from: 'assigned', to: 'picked_up', action: 'pickup' },
    { from: 'picked_up', to: 'in_transit', action: 'depart' },
    { from: 'in_transit', to: 'out_for_delivery', action: 'arrive_for_delivery' },
    { from: 'out_for_delivery', to: 'delivered', action: 'deliver' },
    { from: 'out_for_delivery', to: 'failed', action: 'fail_delivery' },
    { from: 'failed', to: 'assigned', action: 'retry' },
    { from: 'in_transit', to: 'returned', action: 'return_to_sender' },
    // Direct sale from the company (shipping method `direct_sale`): the customer takes the goods at the company's own counter — no driver, route, custody or transit, so one step takes the shipment from `created` straight to `delivered`.
    { from: 'created', to: 'delivered', action: 'direct_handover' },
  ],
};
