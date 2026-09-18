import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * ADR-048 — Path B (Controlled Procurement Cycle): Purchase Request
 * lifecycle. `convert_to_rfq` is fired only internally by
 * `PurchaseRequestService.createRfqFromRequest` (never a raw client
 * action) — the same "service orchestrates the transition" discipline
 * `SupplierInvoiceService`/`GoodsReceiptService` already use for their
 * own derived states.
 */
export const PURCHASE_REQUEST_PROCESS: ProcessDefinition = {
  key: 'purchase_request_lifecycle',
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'submitted', action: 'submit' },
    { from: 'submitted', to: 'approved', action: 'approve' },
    { from: 'submitted', to: 'rejected', action: 'reject' },
    { from: 'draft', to: 'cancelled', action: 'cancel' },
    { from: 'submitted', to: 'cancelled', action: 'cancel' },
    { from: 'approved', to: 'cancelled', action: 'cancel' },
    { from: 'approved', to: 'converted_to_rfq', action: 'convert_to_rfq' },
  ],
};
