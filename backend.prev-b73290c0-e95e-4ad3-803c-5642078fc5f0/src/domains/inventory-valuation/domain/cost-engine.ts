import { EntityManager } from 'typeorm';

/**
 * F08 — Inventory Valuation (ADR-041 D25). F08-internal only — never
 * imported by `inventory-warehouse` or `accounting` directly; those
 * domains see only `InventoryValuationContract`
 * (`foundation/module-registry/contracts/inventory-events.contract.ts`).
 * `MovingAverageCostEngine` is the only implementation shipped in F08. A
 * future FIFO/Standard-Cost engine implements this SAME interface — only
 * F08's own DI binding changes to select one; zero change to the
 * contract, F07's handler bridge, or any operational code.
 *
 * D18b naming split: `resolveIssueCost` is PURE (no mutation — correct
 * for Moving Average specifically, since knowing the current average
 * requires no write); every other method mutates the running state and
 * appends an append-only `InventoryValuationMovement` history row.
 */
export interface CostEngine {
  /** PURE — no mutation. The current running average cost, or null if none exists yet. */
  resolveIssueCost(productId: string, warehouseId: string, manager?: EntityManager): Promise<{ unitCostBase: string } | null>;

  /**
   * MUTATING — decrements the running state by `quantity` at the CURRENT average cost, appends a
   * history row. Returns `null` when there is no valuation state to consume from at all
   * (`no_valuation_source`), or `{ rejected: 'negative_on_hand' }` when `quantity` exceeds the
   * current on-hand quantity — in BOTH cases, no mutation of any kind occurs.
   */
  applyIssue(
    productId: string,
    warehouseId: string,
    quantity: number,
    idempotencyKey: string,
    manager?: EntityManager,
  ): Promise<{ unitCostBase: string; totalCostBase: string } | { rejected: 'negative_on_hand' } | null>;

  /** MUTATING — the one scoped receipt path (ADR-041 D7): a maker-supplied unit cost, never inferred. */
  applyReceipt(
    productId: string,
    warehouseId: string,
    quantity: number,
    unitCostBase: string,
    idempotencyKey: string,
    manager?: EntityManager,
  ): Promise<void>;

  /** MUTATING — internal value movement only (ADR-041 D9); publishes no GL event, moves value at the FROM warehouse's current average cost. */
  applyTransfer(
    productId: string,
    fromWarehouseId: string,
    toWarehouseId: string,
    quantity: number,
    idempotencyKey: string,
    manager?: EntityManager,
  ): Promise<void | { rejected: 'negative_on_hand' }>;

  /** MUTATING — reversal-not-edit (ADR-041 D14): reapplies the ORIGINAL movement's own recorded cost, inverted, as a NEW history row — never edits history, never recalculates. */
  applyReversal(originalIdempotencyKey: string, reversalIdempotencyKey: string, manager?: EntityManager): Promise<void>;

  /** Read-only — the valued on-hand position per warehouse, for F07's reconciliation (D19). */
  getValuedOnHandTotal(asOfDate?: string, manager?: EntityManager): Promise<Array<{ warehouseId: string; totalValueBase: string }>>;
}

export const COST_ENGINE = Symbol('COST_ENGINE');
