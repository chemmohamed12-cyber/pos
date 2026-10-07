/**
 * Same "declared role table, checked by the service" pattern as Sales
 * Orders' `order-action-roles.ts` — `admin` always passes regardless
 * (checked in the service, not repeated here). `submit`/`recall` are
 * deliberately NOT role-gated beyond `warehouse_worker` (any qualified
 * operator can create/recall their own draft — directive §22: normal
 * operation stays fast); `approve`/`reverse` are the actual control
 * points (directive §11/§17).
 */
export const WAREHOUSE_TRANSACTION_ACTION_ROLES: Record<string, string[]> = {
  submit: ['warehouse_worker', 'inventory_controller'],
  recall: ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller'],
  approve: ['warehouse_supervisor', 'inventory_controller'],
  post: ['warehouse_supervisor', 'inventory_controller'],
  reverse: ['warehouse_supervisor'],
};

/** F5: the workflow capability behind each action (the role lists above stay as the documented legacy leg and the text of the refusal). */
export const WAREHOUSE_TRANSACTION_ACTION_RULES: Record<string, string> = {
  submit: 'inventory.warehouse_tx.submit',
  recall: 'inventory.warehouse_tx.recall',
  approve: 'inventory.warehouse_tx.approve',
  post: 'inventory.warehouse_tx.post',
  reverse: 'inventory.warehouse_tx.reverse',
};
