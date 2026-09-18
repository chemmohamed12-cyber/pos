/**
 * F07 — Inventory Accounting (ADR-040 D7/D12). The FA-01 request-type
 * shapes for inventory *adjustments with a financial impact* — a
 * maker-supplied amount (e.g. a physical count variance the accountant has
 * priced, or a valuation write-down). This is NOT an Inventory Valuation
 * Engine (F08) — F07 posts exactly the amount the maker supplies; it
 * never derives an amount from quantity × any price (CTO Mandatory
 * Condition 1). Routine inventory counts/adjustments with no financial
 * impact never reach FA-01 (CTO directive §15) — they stay entirely in
 * `inventory-warehouse`'s own operational adjustment/count transaction
 * types, untouched by F07.
 *
 * `opening_balance` is deliberately NOT a kind here — F07 defers the
 * inventory opening-balance boundary entirely (ADR-040 D14); adding it
 * later is an additive enum change, not a redesign.
 */

export const INVENTORY_APPROVAL_REQUEST_TYPES = {
  physicalCountVariance: 'accounting.inventory.physical_count_variance',
  valuationWriteDown: 'accounting.inventory.valuation_write_down',
} as const;

/** The permission node an FA-01 checker must hold at `editable` to decide an inventory adjustment request. */
export const INVENTORY_APPROVER_PERMISSION_NODE = 'accounting.inventory.approve';

export type InventoryAdjustmentKind = 'physical_count_variance' | 'valuation_write_down';

export const INVENTORY_ADJUSTMENT_KINDS: readonly InventoryAdjustmentKind[] = [
  'physical_count_variance',
  'valuation_write_down',
] as const;

export function isInventoryAdjustmentKind(v: unknown): v is InventoryAdjustmentKind {
  return typeof v === 'string' && (INVENTORY_ADJUSTMENT_KINDS as readonly string[]).includes(v);
}

/**
 * kind → FA-01 request-type code + minApprovers. **Both kinds are ALWAYS
 * gated** — there is no straight-through path (mirrors F05's every-kind-
 * alwaysGated precedent, ADR-037 D5). An inventory financial adjustment is
 * exactly the kind of event the CTO directive singles out for maker≠checker
 * (§15), never a routine operational posting.
 */
export const INVENTORY_ADJUSTMENT_META: Record<InventoryAdjustmentKind, { requestTypeCode: string; minApprovers: number }> = {
  physical_count_variance: { requestTypeCode: INVENTORY_APPROVAL_REQUEST_TYPES.physicalCountVariance, minApprovers: 1 },
  valuation_write_down: { requestTypeCode: INVENTORY_APPROVAL_REQUEST_TYPES.valuationWriteDown, minApprovers: 2 },
};
