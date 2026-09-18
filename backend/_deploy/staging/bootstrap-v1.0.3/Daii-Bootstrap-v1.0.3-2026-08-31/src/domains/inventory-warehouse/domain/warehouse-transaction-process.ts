import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * A FOURTH+ real workflow reusing the same generic Process Engine as
 * Sales Order approval, Fulfillment pick/pack, and Shipment lifecycle —
 * zero engine changes, per ADR-008. Directive §11's
 * Draft→Submitted→Approved→Posted, plus recall (pull back for edits)
 * and reverse (§17: never delete a posted transaction).
 *
 * `submitted -> posted` via `auto_post` exists ONLY for transaction
 * types that don't require human approval (currently just `receipt` —
 * see `NO_APPROVAL_REQUIRED`); `WarehouseTransactionsService` is the one
 * place that decides which action to fire, never the engine itself.
 * Recording an honest `auto_post` action (rather than faking an
 * `approve` nobody performed) keeps the audit trail truthful.
 */
export const WAREHOUSE_TRANSACTION_PROCESS: ProcessDefinition = {
  key: 'warehouse_transaction',
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'submitted', action: 'submit' },
    { from: 'submitted', to: 'draft', action: 'recall' },
    { from: 'submitted', to: 'posted', action: 'auto_post' },
    { from: 'submitted', to: 'approved', action: 'approve' },
    { from: 'approved', to: 'posted', action: 'post' },
    { from: 'posted', to: 'reversed', action: 'reverse' },
  ],
};
