/** Warehouse & Inventory Control UX/UI V1 — the five operator-facing transaction types (directive §7/§9). */
export type WarehouseTransactionType = 'receipt' | 'issue' | 'transfer' | 'adjustment' | 'count';

/** The Numbering series key (registered in `numbering_sequences`) each type posts under — WH-IN-2026-000001 etc. */
export const NUMBERING_SERIES_BY_TYPE: Record<WarehouseTransactionType, string> = {
  receipt: 'warehouse_receipt',
  issue: 'warehouse_issue',
  transfer: 'warehouse_transfer',
  adjustment: 'warehouse_adjustment',
  count: 'warehouse_count',
};

/** Types that auto-post on submit — no separate human approval step (directive §11: "not every movement type needs every stage"). */
export const NO_APPROVAL_REQUIRED: ReadonlySet<WarehouseTransactionType> = new Set(['receipt']);
