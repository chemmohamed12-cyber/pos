/**
 * Sales Orders — Stage 2 build-order item 25 (Approval).
 * Daii/architecture/decisions/ADR-008-process-engine.md, blueprint §14.
 *
 * Which role(s) may perform each Process Engine action on a Sales
 * Order — domain-specific policy data, kept out of the generic Process
 * Engine (which knows nothing about roles) and out of Authorization
 * (which knows nothing about "orders"). 'admin' is implicitly allowed
 * everywhere via ScopeService's unrestricted-role check elsewhere; this
 * map governs the non-admin roles for each business action.
 */
export const ORDER_ACTION_REQUIRED_ROLES: Record<string, string[]> = {
  submit: ['sales_rep'],
  supervisor_approve: ['sales_supervisor'],
  supervisor_reject: ['sales_supervisor'],
  resubmit: ['sales_rep'],
  manager_approve: ['sales_manager'],
  manager_reject: ['sales_manager'],
  // verify_deposit is never called directly by a client — only DepositService
  // calls it, after its own approval check (Deposit Control domain).
};

/**
 * F5 (Map -> Dual-check -> Migrate -> Retire): the workflow capability (`foundation/authorization/workflow-rules.ts`) that replaces each role list above.
 * The role lists stay as the documented legacy leg (and the text of the refusal); the DECISION is made by the capability / dual-check shim.
 */
export const ORDER_ACTION_RULES: Record<string, string> = {
  submit: 'sales.order.submit',
  supervisor_approve: 'sales.order.supervisor_approve',
  supervisor_reject: 'sales.order.supervisor_reject',
  resubmit: 'sales.order.resubmit',
  manager_approve: 'sales.order.manager_approve',
  manager_reject: 'sales.order.manager_reject',
};
