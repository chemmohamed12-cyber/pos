import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * ADR-048 — Supplier Invoice lifecycle. The exact mirror of
 * `SALES_INVOICE_PROCESS` (Customer Financial Account / AR): `post` is
 * the one place the invoice ever hits the Supplier Ledger;
 * `record_partial_payment`/`mark_paid` are fired only internally by
 * `SupplierPaymentService` after recomputing the invoice's own remaining
 * balance, never raw client-callable actions.
 */
export const SUPPLIER_INVOICE_PROCESS: ProcessDefinition = {
  key: 'supplier_invoice_lifecycle',
  initialState: 'draft',
  transitions: [
    // legacy direct path - used only while the Company's approval workflow is off
    { from: 'draft', to: 'posted', action: 'post' },
    { from: 'draft', to: 'void', action: 'cancel_draft' },
    // phase C-1 (D5): Draft -> Submitted -> Approved -> Posted, with On Hold (matching exception) and Rejected
    { from: 'draft', to: 'submitted', action: 'submit' },
    { from: 'draft', to: 'on_hold', action: 'submit_hold' },
    { from: 'submitted', to: 'approved', action: 'approve' },
    { from: 'on_hold', to: 'approved', action: 'approve_exception' },
    { from: 'submitted', to: 'rejected', action: 'reject' },
    { from: 'on_hold', to: 'rejected', action: 'reject' },
    { from: 'rejected', to: 'draft', action: 'reopen' },
    { from: 'approved', to: 'posted', action: 'post_approved' },
    { from: 'submitted', to: 'void', action: 'cancel_draft' },
    { from: 'on_hold', to: 'void', action: 'cancel_draft' },
    { from: 'approved', to: 'void', action: 'cancel_draft' },
    { from: 'rejected', to: 'void', action: 'cancel_draft' },
    { from: 'posted', to: 'partially_paid', action: 'record_partial_payment' },
    { from: 'posted', to: 'paid', action: 'mark_paid' },
    { from: 'partially_paid', to: 'paid', action: 'mark_paid' },
    { from: 'posted', to: 'void', action: 'void' },
    // T2-S (2026-10-21): a supplier payment reversed through its owning document re-opens the invoice; fired only internally by SupplierPaymentReversalService
    { from: 'paid', to: 'partially_paid', action: 'reopen_partial' },
    { from: 'paid', to: 'posted', action: 'reopen_paid' },
    { from: 'partially_paid', to: 'posted', action: 'reopen_paid' },
  ],
};
