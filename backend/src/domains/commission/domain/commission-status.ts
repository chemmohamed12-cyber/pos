/** ADR-068 §1 — Phase 1 closed scope: Sales Rep, Customer, Customer Group only. */
export type CommissionPolicyScope = 'sales_rep' | 'customer' | 'customer_group';

/** ADR-068 §3 — per-policy, never a global fixed setting. */
export type CommissionBasis = 'gross_sales' | 'net_sales' | 'collected_amount';

export type CommissionRateModel = 'flat' | 'target_tiered';

/** ADR-071 §6 — `draft -> submitted -> approved | rejected`, driven by `ProcessEngineService`. */
export type CommissionApprovalBatchStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export const COMMISSION_BATCH_PROCESS_KEY = 'commission_approval_batch';

/** ADR-068 §H, ADR-070 §18's mirrored shape — corrections are new records, never overwrites. */
export type CommissionAdjustmentKind = 'adjustment' | 'correction' | 'recalculation';
