/**
 * ADR-070 §5 — `Draft -> Calculated -> Reviewed -> Approved -> Posted`,
 * driven by `ProcessEngineService` (`ADR-008`), not a bespoke status
 * column with manual transition checks. `approved -> posted` is NOT a
 * second human decision (ADR-070 §5's own correction) — it fires
 * automatically from the same `approval.request.approved` event handler
 * shape every other FA-01-gated transition in this codebase uses.
 * `PayrollRun.status = 'posted'` means posting intent durably committed —
 * it is explicitly NOT evidence that the GL journal exists
 * (`ADR-070 §6`'s reconciliation invariant; only `FinancialEvent.status =
 * 'POSTED'` is that evidence).
 */
export type PayrollRunStatus = 'draft' | 'calculated' | 'reviewed' | 'approved' | 'posted';

export const PAYROLL_RUN_PROCESS_KEY = 'payroll_run';

/** Day-type determination outcome (ADR-070 §9/§C) — never derived from `AttendanceDay.status` alone. */
export type PayrollDayType = 'working' | 'weekend' | 'holiday' | 'approved_leave' | 'unclassified';
export type PayrollDayPayImpact = 'none' | 'deduction' | 'leave';

/** `ADR-067 §G`'s closed, two-category deduction taxonomy. */
export type PayrollDeductionCategory = 'system_derived' | 'approved_external';

/** `ADR-070 §18`'s three correction kinds — never a direct overwrite. */
export type PayrollAdjustmentKind = 'adjustment' | 'correction' | 'recalculation';
