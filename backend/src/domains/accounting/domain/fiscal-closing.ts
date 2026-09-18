/**
 * F13 — Financial Closing (ADR-046). FA-01 request-type codes for the two
 * gated `FiscalPeriod` transitions (`close`, `reopen`) and for
 * `FiscalYear.close` — free-text `ApprovalRequestType.code` strings, a
 * namespace entirely separate from `permission_nodes` and NOT subject to
 * ADR-024's closed permission-verb list (ADR-046 D4/D5).
 */
export const FISCAL_CLOSING_REQUEST_TYPES = {
  periodClose: 'accounting.fiscal_period.close',
  periodReopen: 'accounting.fiscal_period.reopen',
  /**
   * ADR-051 §1.3/§5 (Month-End Closing / Black Box, Phase 3) — the
   * reclose-after-reopen path (`reopened -> closed`, action
   * `close_after_reopen`), gated through FA-01 exactly like `periodClose`
   * (closes the gap where this transition was previously reachable,
   * ungated, through the routine `transitionPeriod` endpoint). A distinct
   * code, not a reuse of `periodClose` — costs nothing now and lets a
   * future, stricter reclose-specific approval matrix rule be layered in
   * later purely as configuration (ADR-051 §1.6).
   */
  periodReclose: 'accounting.fiscal_period.reclose',
  yearClose: 'accounting.fiscal_year.close',
} as const;

/** The FA-01 checker permission nodes (ADR-046 D5) — real permission_nodes, both end in the legal `approve` verb. */
export const FISCAL_PERIOD_APPROVER_PERMISSION_NODE = 'accounting.fiscal_period.approve';
export const FISCAL_YEAR_APPROVER_PERMISSION_NODE = 'accounting.fiscal_year.approve';

/** ADR-046 D6 — F01's own Blueprint already specified this event's shape; F13 finally publishes it. */
export const FISCAL_PERIOD_STATUS_CHANGED_EVENT = 'accounting.fiscal_period.status_changed';
/** ADR-046 D6 — new, symmetric event; F01 only declared the period-level one. */
export const FISCAL_YEAR_STATUS_CHANGED_EVENT = 'accounting.fiscal_year.status_changed';

export const FISCAL_CLOSING_META = { minApprovers: 1 } as const;
