/**
 * CRM / Customer Management — Configurable Sales Order workflow policy.
 * Daii/planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md Gap G-1,
 * CTO handover directive §6.
 *
 * Real operating evidence (12 live company ledgers, analyzed in the
 * mapping package above) shows zero precedent for a mandatory
 * supervisor+manager approval chain or a mandatory deposit gate — the
 * actual business runs on open-account trade credit. Daii's V1 Sales
 * Order workflow (submit -> supervisor_review -> manager_approval ->
 * deposit_verification -> released) is a deliberate, justified
 * capability the platform offers, not a practice to delete — but it
 * must not be the ONLY policy every customer is forced through. This
 * type is the per-customer switch: 'standard' preserves the existing
 * gated chain exactly as built; 'open_account' is the trusted-customer
 * fast path (submit -> released, no review, no deposit). Default is
 * 'standard' so every existing customer's behavior is unchanged until
 * an admin/sales_manager explicitly opts a customer into open-account.
 */
export type OrderWorkflowPolicy = 'standard' | 'open_account';

export const ORDER_WORKFLOW_POLICIES: OrderWorkflowPolicy[] = ['standard', 'open_account'];

export function isValidOrderWorkflowPolicy(value: string): value is OrderWorkflowPolicy {
  return (ORDER_WORKFLOW_POLICIES as string[]).includes(value);
}
