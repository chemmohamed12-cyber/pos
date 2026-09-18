/**
 * Process Engine — Stage 2 build-order item 18.
 * Daii/architecture/decisions/ADR-008-process-engine.md.
 *
 * Adapted from baseline/server/engines/process-engine.js (Class A/B —
 * the single best asset found across all Stage 0 audits,
 * Daii/_source-audits/baseline/): a stateless state machine that knows
 * only `(state, action, actor)` — no knowledge of "orders" or any
 * business noun. A ProcessDefinition is plain configuration data, not
 * code, per blueprint §41 principle 11 (no giant monolithic module
 * hardcoding one workflow into the engine).
 */
export interface ProcessTransition {
  from: string;
  to: string;
  action: string;
}

export interface ProcessDefinition {
  key: string;
  initialState: string;
  transitions: ProcessTransition[];
}

/** The Sales Order Approval Workflow (blueprint §14) — the first real Process Definition, defined as data. */
export const SALES_ORDER_APPROVAL_PROCESS: ProcessDefinition = {
  key: 'sales_order_approval',
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'submitted', action: 'submit' },
    { from: 'submitted', to: 'supervisor_review', action: 'start_review' },
    { from: 'supervisor_review', to: 'manager_approval', action: 'supervisor_approve' },
    { from: 'supervisor_review', to: 'pending_resubmission', action: 'supervisor_reject' },
    { from: 'pending_resubmission', to: 'submitted', action: 'resubmit' },
    { from: 'manager_approval', to: 'deposit_verification', action: 'manager_approve' },
    { from: 'manager_approval', to: 'pending_resubmission', action: 'manager_reject' },
    { from: 'deposit_verification', to: 'released', action: 'verify_deposit' },
    // Hotfix 6 (post-v1.0.2, "Create Sales Order Without a Deposit") —
    // data-only alternate edge out of `manager_approval`, straight to
    // `released`, bypassing `deposit_verification` entirely. Fired only
    // by `SalesOrdersService.transitionOrder`'s own auto-advance step
    // (same internal-only pattern as `start_review`/`auto_release`
    // below — no `ORDER_ACTION_REQUIRED_ROLES` entry, so the default-deny
    // check blocks any direct client call) immediately after a normal
    // `manager_approve`, only when the order's `skipDeposit` flag is set.
    // Supervisor/Manager approval themselves are completely untouched —
    // this only ever replaces the deposit-verification step for orders
    // that never had a deposit to verify in the first place.
    { from: 'manager_approval', to: 'released', action: 'manager_approve_no_deposit' },
    // Preliminary Hold Timeout (CTO directive §7): every pre-`released`
    // state can fall back to `draft` if the deposit isn't approved
    // within 24 hours — fired only by the server-side expiry job
    // (`SalesOrdersService.expireHoldForOrder`), never a client action
    // (no `ORDER_ACTION_REQUIRED_ROLES` entry exists for it, so the
    // default-deny fix in `transitionOrder` already blocks it there).
    { from: 'submitted', to: 'draft', action: 'expire_hold' },
    { from: 'supervisor_review', to: 'draft', action: 'expire_hold' },
    { from: 'pending_resubmission', to: 'draft', action: 'expire_hold' },
    { from: 'manager_approval', to: 'draft', action: 'expire_hold' },
    { from: 'deposit_verification', to: 'draft', action: 'expire_hold' },
  ],
};

/**
 * Open-Account Sales Order Workflow — the trusted-customer fast path
 * (Gap G-1, `planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md`;
 * CTO handover directive §6: "must support both open-account/trusted
 * customer workflows and more controlled workflows... do not hardcode
 * one business policy into the entire platform"). Reuses the SAME state
 * names ('draft'/'submitted'/'released') as the standard process so the
 * existing Terminology Registry entries and frontend `StatusBadge`
 * render correctly with zero new translation keys — only the path
 * between them is shorter: no supervisor/manager review, no deposit
 * gate. Selected per order via `SalesOrder.workflowPolicy`
 * (`domains/crm/domain/order-workflow-policy.ts`), snapshotted from the
 * customer at order-creation time.
 */
export const SALES_ORDER_OPEN_ACCOUNT_PROCESS: ProcessDefinition = {
  key: 'sales_order_open_account',
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'submitted', action: 'submit' },
    { from: 'submitted', to: 'released', action: 'auto_release' },
    // Preliminary Hold Timeout (CTO directive §7) — see the standard
    // process's own comment. An open-account order normally releases
    // immediately on submit (no deposit gate), so this only matters if
    // `auto_release` itself somehow didn't fire yet when the hold ages out.
    { from: 'submitted', to: 'draft', action: 'expire_hold' },
  ],
};
