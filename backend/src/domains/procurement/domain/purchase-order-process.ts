import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * ADR-048 — Purchase Order lifecycle. Mirrors the Shipment pattern
 * (`PurchaseOrder` carries NO status column — the Process Engine is the
 * single source of truth). A single `approve` action (procurement-role
 * gated at the controller, same as Sales Order's supervisor/manager
 * gating) rather than the generic Approval Engine — a PO approval is one
 * decision by one role, not a maker-checker multi-approver flow, so it
 * doesn't need a configurable matrix rule the way a supplier bank-account
 * change does (see `SupplierBankAccount`'s doc comment for that contrast).
 *
 * `partially_received`/`received` are driven by `GoodsReceiptService`
 * comparing received-to-date against ordered quantity per line — never a
 * manually-clicked action, matching how Shipment states like `delivered`
 * are driven by `DeliveryService`, not a free client call.
 */
export const PURCHASE_ORDER_PROCESS: ProcessDefinition = {
  key: 'purchase_order_lifecycle',
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'submitted', action: 'submit' },
    { from: 'submitted', to: 'approved', action: 'approve' },
    { from: 'submitted', to: 'draft', action: 'reject' },
    { from: 'draft', to: 'cancelled', action: 'cancel' },
    { from: 'submitted', to: 'cancelled', action: 'cancel' },
    { from: 'approved', to: 'cancelled', action: 'cancel' },
    { from: 'approved', to: 'partially_received', action: 'receive_partial' },
    { from: 'approved', to: 'received', action: 'receive_full' },
    { from: 'partially_received', to: 'partially_received', action: 'receive_partial' },
    { from: 'partially_received', to: 'received', action: 'receive_full' },
    { from: 'received', to: 'closed', action: 'close' },
  ],
};
