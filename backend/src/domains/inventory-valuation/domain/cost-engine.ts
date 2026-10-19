import { EntityManager } from 'typeorm';
import type { HistoryInconsistency, ValuedPosition, ValuedPositionFilter } from '../../../foundation/module-registry/contracts/inventory-events.contract';

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
    businessDate?: string,
  ): Promise<{ unitCostBase: string; totalCostBase: string } | { rejected: 'negative_on_hand' } | null>;

  /** D4 — PURE read: the cost the ORIGINAL issues (by idempotency key) were actually charged; keys without an `issue` row are absent. */
  getIssueCostsByKeys(idempotencyKeys: string[], manager?: EntityManager): Promise<Array<{ idempotencyKey: string; quantity: number; valueBase: string }>>;

  /** MUTATING — the one scoped receipt path (ADR-041 D7): a maker-supplied unit cost, never inferred. */
  applyReceipt(
    productId: string,
    warehouseId: string,
    quantity: number,
    unitCostBase: string,
    idempotencyKey: string,
    manager?: EntityManager,
    businessDate?: string,
  ): Promise<void>;

  /**
   * ADR-061 (Manufacturing) — NARROWLY SCOPED, Manufacturing Finished
   * Goods Output ONLY. Unlike `applyIssue`, the value removed is
   * CALLER-SUPPLIED (`appliedValueBase`), not resolved from this
   * resource's own current average — the one deliberate, explicitly
   * CTO-ratified exception in this engine (ADR-061 §7's Work-Order-pooled
   * costing formula). Every other flow in this codebase MUST keep using
   * `applyIssue`. Guards: `quantity` must not exceed on-hand quantity,
   * AND `appliedValueBase` must not exceed the resource's current total
   * value — either failure returns `{ rejected }` with NO mutation. On
   * success, the remaining on-hand quantity's average cost is
   * recomputed from the REMAINING value (`totalValueBase −
   * appliedValueBase`) ÷ the remaining quantity, so total book value
   * always reconciles exactly even though the applied rate differs from
   * this resource's own natural average — the same "never cache a
   * derived number, always keep it consistent with what's on hand"
   * discipline `applyIssue`/`applyReceipt` already follow.
   */
  applyPolicyValuedIssue(
    productId: string,
    warehouseId: string,
    quantity: number,
    appliedValueBase: string,
    idempotencyKey: string,
    manager?: EntityManager,
  ): Promise<{ appliedValueBase: string } | { rejected: 'negative_on_hand' | 'value_exceeds_on_hand' } | null>;

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
  applyReversal(originalIdempotencyKey: string, reversalIdempotencyKey: string, manager?: EntityManager, businessDate?: string): Promise<{ valueBase: string } | null>;

  /** C6 - value-only change of a position (see `InventoryValuationContract.applyRevaluation`). */
  applyRevaluation(
    productId: string,
    warehouseId: string,
    valueDelta: string,
    idempotencyKey: string,
    manager?: EntityManager,
    businessDate?: string,
  ): Promise<{ valueBase: string } | { rejected: 'no_valuation_source' | 'zero_quantity' | 'value_below_zero' }>;

  /** Read-only — the valued on-hand position per warehouse, for F07's reconciliation (D19). With a PAST `asOfDate` it is rebuilt from the dated history (C1, ADR-INV-08). */
  getValuedOnHandTotal(asOfDate?: string, manager?: EntityManager): Promise<Array<{ warehouseId: string; totalValueBase: string }>>;

  /** C1 (ADR-INV-08) - read-only: the valued position per warehouse AND product, current or as of a date. */
  getValuedPositions(asOfDate?: string, filter?: ValuedPositionFilter, manager?: EntityManager): Promise<ValuedPosition[]>;

  /** C1 - read-only consistency check of the running state against the sum of its own dated history (every pair that disagrees). */
  checkHistoryConsistency(manager?: EntityManager): Promise<HistoryInconsistency[]>;
}

export const COST_ENGINE = Symbol('COST_ENGINE');
