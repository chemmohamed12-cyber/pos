import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * Customer Financial Account / Invoice / AR (CTO directive) — a FIFTH
 * real workflow on the generic Process Engine (Sales Order approval,
 * Fulfillment pick/pack, Shipment lifecycle, Returns, now Sales Invoice).
 * `record_partial_payment`/`mark_paid` are fired only internally by
 * `InvoiceService`/`PaymentsService` after recomputing the invoice's own
 * remaining balance — never raw client-callable actions, same
 * "service orchestrates the transition" discipline
 * `DepositsService.approveDeposit` already uses for Sales Orders'
 * `verify_deposit`.
 */
export const SALES_INVOICE_PROCESS: ProcessDefinition = {
  key: 'sales_invoice_lifecycle',
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
