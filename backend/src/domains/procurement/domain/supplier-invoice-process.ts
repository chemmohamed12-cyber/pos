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
    { from: 'draft', to: 'posted', action: 'post' },
    { from: 'draft', to: 'void', action: 'cancel_draft' },
    { from: 'posted', to: 'partially_paid', action: 'record_partial_payment' },
    { from: 'posted', to: 'paid', action: 'mark_paid' },
    { from: 'partially_paid', to: 'paid', action: 'mark_paid' },
    { from: 'posted', to: 'void', action: 'void' },
  ],
};
